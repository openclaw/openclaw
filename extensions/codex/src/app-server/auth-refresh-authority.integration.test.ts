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
  type AuthProfileStore,
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
import { expect, it, vi, type Mock } from "vitest";
import { fingerprintTokenAuthProfileCacheKey } from "./auth-cache-key.js";
import {
  ensureCodexAppServerClientRuntime,
  recordCodexAppServerAuthHandoff,
} from "./client-runtime.js";
import { CodexAppServerClient } from "./client.js";
import type { RpcRequest, RpcResponse } from "./protocol.js";
import { createClientHarness } from "./test-support.js";
import { closeCodexAppServerTransportAndWait } from "./transport.js";

const PROFILE_ID = "openai:work";
const ACCOUNT_ID = "account-a";
const INITIAL_ACCESS = "initial-access";

type Harness = ReturnType<typeof createStdioAuthRefreshHarness>;
type RefreshOAuth = (credential: OAuthCredential) => Promise<OAuthCredential>;

function oauthProfile(prefix: string, overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai",
    ...overrides,
    access: `${prefix}-access`,
    refresh: `${prefix}-refresh`,
    expires: Date.now() + 60_000,
    accountId: overrides.accountId ?? ACCOUNT_ID,
  };
}

function sendRefresh(harness: Harness, id: string) {
  harness.send({
    id,
    method: "account/chatgptAuthTokens/refresh",
    params: { reason: "unauthorized", previousAccountId: ACCOUNT_ID },
  });
}

async function refreshResponse(harness: Harness, id: string): Promise<RpcResponse> {
  sendRefresh(harness, id);
  for (let index = 0; ; index++) {
    const response = JSON.parse(await harness.waitForWrite(index)) as RpcResponse;
    if (response.id === id) {
      return response;
    }
  }
}

function expectRefreshError(response: RpcResponse, message: string | RegExp) {
  const matching =
    typeof message === "string" ? expect.stringContaining(message) : expect.stringMatching(message);
  expect(response).toMatchObject({
    error: { code: -32603, message: matching },
  });
  expect(response.result).toBeUndefined();
}

function expectStoredRotation(store: AuthProfileStore, prefix: string) {
  expect(store.profiles[PROFILE_ID]).toMatchObject({
    access: `${prefix}-access`,
    refresh: `${prefix}-refresh`,
    accountId: ACCOUNT_ID,
  });
}

function createStdioAuthRefreshHarness() {
  // Retained pipe handles carry the first turn's async context, not their listeners'.
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./test-support/auth-refresh-child.test-support.mjs", import.meta.url))],
    { stdio: "pipe", env: {} },
  );
  const client = CodexAppServerClient.fromTransport(child);
  const writes: string[] = [];
  const responses: ReturnType<typeof createDeferred<string>>[] = [];
  const responseAt = (index: number) => (responses[index] ??= createDeferred<string>());
  client.addNotificationHandler((notification) => {
    if (notification.method !== "fixture/refresh-response") {
      return;
    }
    const line = JSON.stringify(notification.params);
    const index = writes.push(line) - 1;
    responseAt(index).resolve(line);
  });
  client.addCloseHandler(() => {
    for (const pending of responses) {
      pending.reject(new Error("Auth refresh fixture closed before returning its response"));
    }
  });
  return {
    client,
    writes,
    waitForWrite: (index: number) => responseAt(index).promise,
    send(message: RpcRequest) {
      child.stdin.write(`${JSON.stringify({ method: "fixture/send-request", params: message })}\n`);
    },
  };
}

async function withAuthRefreshHarness(
  run: (fixture: {
    agentDir: string;
    harness: Harness;
    refreshOAuth: Mock<RefreshOAuth>;
    otherProviderRefresh: ReturnType<typeof vi.fn>;
    retainedStore: AuthProfileStore;
    authRefreshFailed: Promise<void>;
  }) => Promise<void>,
  createHarness: () => Harness = createClientHarness,
): Promise<void> {
  const refreshOAuth = vi.fn<RefreshOAuth>(async (profile) => oauthProfile("rotated", profile));
  await withStateDirEnv("openclaw-codex-auth-refresh-authority-", async ({ stateDir }) => {
    const bundledRoot = path.join(stateDir, "bundled");
    for (const id of ["openai", "anthropic"]) {
      const rootDir = path.join(bundledRoot, id);
      fs.mkdirSync(rootDir, { recursive: true });
      fs.writeFileSync(
        path.join(rootDir, "openclaw.plugin.json"),
        JSON.stringify({
          id,
          providers: [id],
          enabledByDefault: true,
          configSchema: { type: "object", properties: {} },
        }),
      );
      fs.writeFileSync(
        path.join(rootDir, "index.js"),
        'throw new Error("Unexpected fixture cold load");\n',
      );
    }
    await withEnvAsync(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      },
      async () => {
        const previousRegistry = getActivePluginRegistry();
        const manifests = loadPluginManifestRegistryCore({ workspaceDir: stateDir });
        const registration = createPluginRegistry({
          runtime: createPluginRuntimeMock(),
          logger: { info() {}, warn() {}, error() {}, debug() {} },
          activateGlobalSideEffects: false,
        });
        const otherProviderRefresh = vi.fn(async (credential: OAuthCredential) => credential);
        for (const [id, label, providerRefresh] of [
          ["openai", "OpenAI", refreshOAuth],
          ["anthropic", "Anthropic", otherProviderRefresh],
        ] as const) {
          const manifest = manifests.plugins.find((plugin) => plugin.id === id);
          if (!manifest || manifest.rootDir !== path.join(bundledRoot, id)) {
            throw new Error(`Unexpected fixture manifest owner: ${id}`);
          }
          const record = createPluginRecord({
            id,
            source: manifest.source,
            rootDir: manifest.rootDir,
            origin: "bundled",
            format: "bundle",
            providerIds: [id],
            configSchema: true,
          });
          registration.registry.plugins.push(record);
          registration.createApi(record, { config: {} }).registerProvider({
            id,
            label,
            auth: [],
            refreshOAuth: providerRefresh,
          });
        }
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
            refreshOAuth,
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

it.each<[string, AuthProfileCredential | undefined]>([
  ["is deleted", undefined],
  ["becomes an API key", { type: "api_key", provider: "openai", key: "replacement-api-key" }],
  ["becomes an OpenAI token", { type: "token", provider: "openai", token: "replacement-token" }],
  ["changes OAuth provider", oauthProfile("other", { provider: "anthropic" })],
])("rejects a retained persisted OAuth profile when canonical authority %s", (_name, credential) =>
  withAuthRefreshHarness(
    async ({ agentDir, harness, refreshOAuth, otherProviderRefresh, retainedStore }) => {
      saveAuthProfileStore(
        { version: 1, profiles: credential ? { [PROFILE_ID]: credential } : {} },
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

      expect(JSON.stringify(response)).not.toMatch(/initial-access|rotated-access/);
    },
  ),
);

it("keeps a retained client fenced after a rejected account rotation", () =>
  withAuthRefreshHarness(async ({ harness, refreshOAuth }) => {
    refreshOAuth.mockImplementation(async (credential) =>
      oauthProfile("other-account", { ...credential, accountId: "account-b" }),
    );
    const rejected = await refreshResponse(harness, "refresh-rejected");
    expectRefreshError(rejected, /different OAuth account/i);

    const afterFence = await refreshResponse(harness, "refresh-after-fence");
    expectRefreshError(
      afterFence,
      `auth profile "${PROFILE_ID}" could not resolve usable OAuth credentials from its OpenClaw credential store.`,
    );
    expect(afterFence.error?.message).not.toMatch(/HTTP 401|sign in again|re-authenticate/i);
    expect(refreshOAuth).toHaveBeenCalledTimes(1);

    expect(JSON.stringify([rejected, afterFence])).not.toMatch(
      /initial-access|other-account-access/,
    );
  }, createStdioAuthRefreshHarness));

it("returns and persists a retained stdio refresh after its first-turn scope closes", async () => {
  const firstTurn = new AsyncWorkScope();
  await withAuthRefreshHarness(
    async ({ agentDir, harness, retainedStore, refreshOAuth }) => {
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
      expectStoredRotation(retainedStore, "rotated");
      clearRuntimeAuthProfileStoreSnapshots();
      expectStoredRotation(loadAuthProfileStoreForSecretsRuntime(agentDir), "rotated");
    },
    () => firstTurn.run(createStdioAuthRefreshHarness),
  );
});

it("joins an admitted rotation through persistence without replying or admitting refreshes after close", async () => {
  const providerStarted = createDeferred<void>();
  const releaseProvider = createDeferred<void>();
  const transport = createClientHarness({ autoEmitExit: false });

  await withAuthRefreshHarness(
    async ({ agentDir, harness, authRefreshFailed, refreshOAuth }) => {
      refreshOAuth.mockImplementation(async (credential) => {
        providerStarted.resolve();
        await releaseProvider.promise;
        return oauthProfile("closing-rotated", credential);
      });
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
        // Physical-exit barrier exposes early close without waiting for the provider.
        await setImmediate();
        expect(closed).toBe(false);

        releaseProvider.resolve();
        await closing;
        clearRuntimeAuthProfileStoreSnapshots();
        expectStoredRotation(loadAuthProfileStoreForSecretsRuntime(agentDir), "closing-rotated");
        expect(refreshOAuth).toHaveBeenCalledTimes(1);
        expect(harness.writes).toEqual([]);
      } finally {
        releaseProvider.resolve();
        // Settle persistence before private DB cleanup even on assertion failure.
        await authRefreshFailed;
        await closing;
      }
    },
    () => transport,
  );
});
