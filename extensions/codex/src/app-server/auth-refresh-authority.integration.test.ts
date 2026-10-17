import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
  saveAuthProfileStore,
  type AuthProfileCredential,
  type OAuthCredential,
} from "openclaw/plugin-sdk/agent-runtime";
import { AsyncWorkScope } from "openclaw/plugin-sdk/concurrency-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createPluginRegistry,
  createPluginRecord,
  createPluginRuntimeMock,
  getActivePluginRegistry,
  loadPluginManifestRegistryCore,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertAuthProfileAsync } from "openclaw/plugin-sdk/provider-auth";
import { withEnvAsync, withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { fingerprintTokenAuthProfileCacheKey } from "./auth-cache-key.js";
import {
  ensureCodexAppServerClientRuntime,
  recordCodexAppServerAuthHandoff,
} from "./client-runtime.js";
import { CodexAppServerClient } from "./client.js";
import { createClientHarness } from "./test-support.js";
import { closeCodexAppServerTransportAndWait } from "./transport.js";

const PROFILE_ID = "openai:work";
const ACCOUNT_ID = "account-a";
const INITIAL_ACCESS = "initial-access";

type Harness = Pick<
  ReturnType<typeof createClientHarness>,
  "client" | "writes" | "send" | "waitForWrite"
>;
type JsonRpcResponse = {
  id?: string | number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

function oauthProfile(prefix: string, overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai",
    access: `${prefix}-access`,
    refresh: `${prefix}-refresh`,
    expires: Date.now() + 60_000,
    accountId: ACCOUNT_ID,
    ...overrides,
  };
}

function sendRefresh(harness: Harness, id: string) {
  harness.send({
    id,
    method: "account/chatgptAuthTokens/refresh",
    params: { reason: "unauthorized", previousAccountId: ACCOUNT_ID },
  });
}

async function refreshResponse(harness: Harness, id: string) {
  sendRefresh(harness, id);
  return waitForResponse(harness, id);
}

function expectRefreshError(response: JsonRpcResponse, message: string | RegExp) {
  expect(response).toMatchObject({
    error: {
      code: -32603,
      message:
        typeof message === "string"
          ? expect.stringContaining(message)
          : expect.stringMatching(message),
    },
  });
  expect(response.result).toBeUndefined();
}

function rotateCredential(credential: OAuthCredential, prefix: string, accountId = ACCOUNT_ID) {
  return {
    ...credential,
    access: `${prefix}-access`,
    refresh: `${prefix}-refresh`,
    expires: Date.now() + 60_000,
    accountId,
  };
}

async function waitForResponse(harness: Harness, id: string): Promise<JsonRpcResponse> {
  for (let index = 0; ; index++) {
    const response = JSON.parse(await harness.waitForWrite(index)) as JsonRpcResponse;
    if (response.id === id) {
      return response;
    }
  }
}

function createStdioAuthRefreshHarness(): Harness {
  // These real pipe handles must be created in the first turn, not just their
  // listeners: later reads inherit the async context of the retained handles.
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./test-support/auth-refresh-child.test-support.mjs", import.meta.url))],
    { stdio: "pipe", env: {} },
  );
  const client = CodexAppServerClient.fromTransportForTests(child);
  const writes: string[] = [];
  const pendingWrites = new Map<number, ReturnType<typeof createDeferred<string>>>();
  client.addNotificationHandler((notification) => {
    if (notification.method !== "fixture/refresh-response") {
      return;
    }
    const line = JSON.stringify(notification.params);
    const index = writes.push(line) - 1;
    pendingWrites.get(index)?.resolve(line);
    pendingWrites.delete(index);
  });
  client.addCloseHandler(() => {
    for (const pending of pendingWrites.values()) {
      pending.reject(new Error("Auth refresh fixture closed before returning its response"));
    }
    pendingWrites.clear();
  });
  return {
    client,
    writes,
    waitForWrite(index) {
      if (writes[index] !== undefined) {
        return Promise.resolve(writes[index]);
      }
      const pending = createDeferred<string>();
      pendingWrites.set(index, pending);
      return pending.promise;
    },
    send(message) {
      child.stdin.write(`${JSON.stringify({ method: "fixture/send-request", params: message })}\n`);
    },
  };
}

async function withAuthRefreshHarness(
  refreshOAuth: (credential: OAuthCredential) => Promise<OAuthCredential>,
  run: (fixture: {
    agentDir: string;
    harness: Harness;
    otherProviderRefresh: ReturnType<typeof vi.fn>;
    retainedStore: ReturnType<typeof loadAuthProfileStoreForSecretsRuntime>;
    authRefreshFailed: Promise<void>;
  }) => Promise<void>,
  createHarness: () => Harness = createClientHarness,
): Promise<void> {
  await withStateDirEnv("openclaw-codex-auth-refresh-authority-", async ({ stateDir }) => {
    const bundledRoot = path.join(stateDir, "bundled");
    for (const id of ["openai", "anthropic"]) {
      const rootDir = path.join(bundledRoot, id);
      fs.mkdirSync(rootDir, { recursive: true });
      const files = {
        "package.json": JSON.stringify({
          name: `auth-refresh-fixture-${id}`,
          openclaw: { extensions: ["./index.js"] },
        }),
        "openclaw.plugin.json": JSON.stringify({
          id,
          providers: [id],
          enabledByDefault: true,
          configSchema: { type: "object", properties: {} },
        }),
        "index.js": 'throw new Error("Unexpected fixture cold load");\n',
      };
      for (const [name, contents] of Object.entries(files)) {
        fs.writeFileSync(path.join(rootDir, name), contents);
      }
    }
    await withEnvAsync(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      },
      async () => {
        const previousRegistry = getActivePluginRegistry();
        const manifests = loadPluginManifestRegistryCore({ workspaceDir: stateDir });
        const createProviderRecord = (id: string) => {
          const manifest = manifests.plugins.find((plugin) => plugin.id === id);
          if (!manifest || manifest.rootDir !== path.join(bundledRoot, id)) {
            throw new Error(`Unexpected fixture manifest owner: ${id}`);
          }
          return createPluginRecord({
            id,
            source: manifest.source,
            rootDir: manifest.rootDir,
            origin: "bundled",
            format: "bundle",
            enabled: true,
            providerIds: [id],
            configSchema: true,
          });
        };
        const registration = createPluginRegistry({
          runtime: createPluginRuntimeMock(),
          logger: { info() {}, warn() {}, error() {}, debug() {} },
          activateGlobalSideEffects: false,
        });
        const record = createProviderRecord("openai");
        const otherProviderRecord = createProviderRecord("anthropic");
        registration.registry.plugins.push(record, otherProviderRecord);
        const api = registration.createApi(record, { config: {} });
        const otherProviderRefresh = vi.fn(async (credential: OAuthCredential) => credential);
        api.registerProvider({
          id: "openai",
          label: "OpenAI",
          auth: [],
          refreshOAuth,
        });
        registration.createApi(otherProviderRecord, { config: {} }).registerProvider({
          id: "anthropic",
          label: "Anthropic",
          auth: [],
          refreshOAuth: otherProviderRefresh,
        });
        const harness = createHarness();
        const authRefreshFailed = createDeferred<void>();
        try {
          setActivePluginRegistry(registration.registry, undefined, "default", stateDir);

          const agentDir = path.join(stateDir, "agents", "main", "agent");
          await upsertAuthProfileAsync({
            agentDir,
            profileId: PROFILE_ID,
            credential: oauthProfile("initial"),
          });
          const retainedStore = loadAuthProfileStoreForSecretsRuntime(agentDir);
          ensureCodexAppServerClientRuntime(harness.client, {
            agentDir,
            authProfileId: PROFILE_ID,
            authProfileStore: retainedStore,
            onAuthRefreshFailure: () => authRefreshFailed.resolve(),
          });
          recordCodexAppServerAuthHandoff(harness.client, {
            accessFingerprint: fingerprintTokenAuthProfileCacheKey(INITIAL_ACCESS),
            chatgptAccountId: ACCOUNT_ID,
          });

          await run({
            agentDir,
            harness,
            otherProviderRefresh,
            retainedStore,
            authRefreshFailed: authRefreshFailed.promise,
          });
        } finally {
          await harness.client.closeAndWait();
          clearRuntimeAuthProfileStoreSnapshots();
          closeOpenClawStateDatabaseForTest();
          if (previousRegistry) {
            setActivePluginRegistry(previousRegistry);
          } else {
            resetPluginRuntimeStateForTest();
          }
        }
      },
    );
  });
}

describe("Codex app-server auth refresh authority", () => {
  it.each([
    { name: "is deleted", credential: undefined },
    {
      name: "becomes an OpenAI API key",
      credential: {
        type: "api_key",
        provider: "openai",
        key: "replacement-api-key",
      },
    },
    {
      name: "becomes an OpenAI token",
      credential: {
        type: "token",
        provider: "openai",
        token: "replacement-token",
      },
    },
    {
      name: "becomes another provider's OAuth credential",
      credential: oauthProfile("other-provider", {
        provider: "anthropic",
        expires: Date.now() + 24 * 60 * 60_000,
      }),
    },
  ] satisfies Array<{ name: string; credential: AuthProfileCredential | undefined }>)(
    "rejects a retained persisted OAuth profile when canonical authority $name",
    async ({ credential }) => {
      const refreshOAuth = vi.fn(async (current: OAuthCredential) =>
        rotateCredential(current, "retired-profile-rotated"),
      );

      await withAuthRefreshHarness(
        refreshOAuth,
        async ({ agentDir, harness, otherProviderRefresh, retainedStore }) => {
          saveAuthProfileStore(
            {
              version: 1,
              profiles: credential ? { [PROFILE_ID]: credential } : {},
            },
            agentDir,
            {
              filterExternalAuthProfiles: false,
              sharedStoreWrite: true,
              syncExternalCli: false,
            },
          );
          expect(retainedStore.profiles[PROFILE_ID]).toMatchObject({
            type: "oauth",
            access: INITIAL_ACCESS,
          });

          const response = await refreshResponse(harness, "refresh-authority-lost");
          expectRefreshError(
            response,
            `auth profile "${PROFILE_ID}" is no longer an OpenAI OAuth credential in its persisted OpenClaw store.`,
          );
          expect(response.error?.message).not.toMatch(/HTTP 401|sign in again|re-authenticate/i);
          expect(refreshOAuth).not.toHaveBeenCalled();
          expect(otherProviderRefresh).not.toHaveBeenCalled();

          const serialized = JSON.stringify(response);
          expect(serialized).not.toContain(INITIAL_ACCESS);
          expect(serialized).not.toContain("retired-profile-rotated-access");
        },
      );
    },
  );

  it("keeps a retained client fenced after a rejected account rotation", async () => {
    const refreshOAuth = vi.fn(async (credential: OAuthCredential) =>
      rotateCredential(credential, "other-account", "account-b"),
    );

    await withAuthRefreshHarness(
      refreshOAuth,
      async ({ harness }) => {
        const rejected = await refreshResponse(harness, "refresh-rejected");
        expectRefreshError(rejected, /different OAuth account/i);

        const afterFence = await refreshResponse(harness, "refresh-after-fence");
        expectRefreshError(
          afterFence,
          `auth profile "${PROFILE_ID}" could not resolve usable OAuth credentials from its OpenClaw credential store.`,
        );
        expect(afterFence.error?.message).not.toMatch(/HTTP 401|sign in again|re-authenticate/i);
        expect(refreshOAuth).toHaveBeenCalledTimes(1);

        const responses = JSON.stringify([rejected, afterFence]);
        expect(responses).not.toContain(INITIAL_ACCESS);
        expect(responses).not.toContain("other-account-access");
      },
      createStdioAuthRefreshHarness,
    );
  });

  it("returns and persists a retained stdio refresh after its first-turn scope closes", async () => {
    const firstTurn = new AsyncWorkScope();
    const refreshOAuth = vi.fn(async (credential: OAuthCredential) =>
      rotateCredential(credential, "rotated"),
    );

    await withAuthRefreshHarness(
      refreshOAuth,
      async ({ agentDir, harness, retainedStore }) => {
        await firstTurn.drain();
        expect(() => firstTurn.run(() => undefined)).toThrow("Async work scope is closed");
        await expect(refreshResponse(harness, "refresh-accepted")).resolves.toEqual({
          id: "refresh-accepted",
          result: {
            accessToken: "rotated-access",
            chatgptAccountId: ACCOUNT_ID,
            chatgptPlanType: null,
          },
        });
        expect(refreshOAuth).toHaveBeenCalledTimes(1);
        expect(retainedStore.profiles[PROFILE_ID]).toMatchObject({
          access: "rotated-access",
          refresh: "rotated-refresh",
          accountId: ACCOUNT_ID,
        });

        clearRuntimeAuthProfileStoreSnapshots();
        expect(loadAuthProfileStoreForSecretsRuntime(agentDir).profiles[PROFILE_ID]).toMatchObject({
          access: "rotated-access",
          refresh: "rotated-refresh",
          accountId: ACCOUNT_ID,
        });
      },
      () => firstTurn.run(createStdioAuthRefreshHarness),
    );
  });

  it("joins an admitted rotation through persistence without replying or admitting refreshes after close", async () => {
    const providerStarted = createDeferred<void>();
    const releaseProvider = createDeferred<void>();
    const refreshOAuth = vi.fn(async (credential: OAuthCredential) => {
      providerStarted.resolve();
      await releaseProvider.promise;
      return rotateCredential(credential, "closing-rotated");
    });
    const transport = createClientHarness({ autoEmitExit: false });

    await withAuthRefreshHarness(
      refreshOAuth,
      async ({ agentDir, harness, authRefreshFailed }) => {
        sendRefresh(harness, "refresh-before-close");
        await providerStarted.promise;
        let closed = false;
        const closing = harness.client.closeAndWait().then((result) => {
          closed = true;
          return result;
        });
        try {
          sendRefresh(harness, "refresh-after-close");
          transport.emitExit();
          await closeCodexAppServerTransportAndWait(transport.process);
          // An event-loop barrier after physical exit lets an incorrectly early
          // close settle; it does not wait an arbitrary amount for the provider.
          await setImmediate();
          expect(closed).toBe(false);

          releaseProvider.resolve();
          await closing;
          clearRuntimeAuthProfileStoreSnapshots();
          expect(
            loadAuthProfileStoreForSecretsRuntime(agentDir).profiles[PROFILE_ID],
          ).toMatchObject({
            access: "closing-rotated-access",
            refresh: "closing-rotated-refresh",
            accountId: ACCOUNT_ID,
          });
          expect(refreshOAuth).toHaveBeenCalledTimes(1);
          expect(harness.writes).toEqual([]);
        } finally {
          releaseProvider.resolve();
          // Also settle the owner on a pre-fix assertion failure before removing
          // the private database; the closed-client callback follows persistence.
          await authRefreshFailed;
          await closing;
        }
      },
      () => transport,
    );
  });
});
