import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
  saveAuthProfileStore,
  type AuthProfileCredential,
  type OAuthCredential,
} from "openclaw/plugin-sdk/agent-runtime";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createPluginRegistry,
  createPluginRecord,
  createPluginRuntimeMock,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { fingerprintTokenAuthProfileCacheKey } from "./auth-cache-key.js";
import {
  ensureCodexAppServerClientRuntime,
  recordCodexAppServerAuthHandoff,
} from "./client-runtime.js";
import { createClientHarness } from "./test-support.js";

const PROFILE_ID = "openai:work";
const ACCOUNT_ID = "account-a";
const INITIAL_ACCESS = "initial-access";

type Harness = ReturnType<typeof createClientHarness>;
type JsonRpcResponse = {
  id?: string | number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

async function waitForResponse(harness: Harness, id: string): Promise<JsonRpcResponse> {
  let response: JsonRpcResponse | undefined;
  await vi.waitFor(
    () => {
      response = harness.writes
        .map((line) => JSON.parse(line) as JsonRpcResponse)
        .find((message) => message.id === id);
      expect(response, `observed wire output: ${JSON.stringify(harness.writes)}`).toBeDefined();
    },
    { timeout: 15_000 },
  );
  return response as JsonRpcResponse;
}

async function withAuthRefreshHarness(
  refreshOAuth: (credential: OAuthCredential) => Promise<OAuthCredential>,
  run: (fixture: {
    agentDir: string;
    harness: Harness;
    otherProviderRefresh: ReturnType<typeof vi.fn>;
    retainedStore: ReturnType<typeof loadAuthProfileStoreForSecretsRuntime>;
  }) => Promise<void>,
): Promise<void> {
  await withStateDirEnv("openclaw-codex-auth-refresh-authority-", async ({ stateDir }) => {
    const previousRegistry = getActivePluginRegistry();
    const pluginRoot = path.join(process.cwd(), "extensions", "openai");
    const registration = createPluginRegistry({
      runtime: createPluginRuntimeMock(),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({
      id: "openai",
      source: path.join(pluginRoot, "index.ts"),
      rootDir: pluginRoot,
      origin: "bundled",
      format: "bundle",
      enabled: true,
      providerIds: ["openai"],
      configSchema: true,
    });
    const otherProviderRecord = createPluginRecord({
      id: "anthropic",
      source: path.join(pluginRoot, "anthropic.ts"),
      rootDir: pluginRoot,
      origin: "bundled",
      format: "bundle",
      enabled: true,
      providerIds: ["anthropic"],
      configSchema: true,
    });
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
    setActivePluginRegistry(registration.registry, undefined, "default", process.cwd());

    const agentDir = path.join(stateDir, "agents", "main", "agent");
    upsertAuthProfile({
      agentDir,
      profileId: PROFILE_ID,
      credential: {
        type: "oauth",
        provider: "openai",
        access: INITIAL_ACCESS,
        refresh: "initial-refresh",
        expires: Date.now() + 60_000,
        accountId: ACCOUNT_ID,
      },
    });
    const retainedStore = loadAuthProfileStoreForSecretsRuntime(agentDir);
    const harness = createClientHarness();
    ensureCodexAppServerClientRuntime(harness.client, {
      agentDir,
      authProfileId: PROFILE_ID,
      authProfileStore: retainedStore,
    });
    recordCodexAppServerAuthHandoff(harness.client, {
      accessFingerprint: fingerprintTokenAuthProfileCacheKey(INITIAL_ACCESS),
      chatgptAccountId: ACCOUNT_ID,
    });

    try {
      await run({ agentDir, harness, otherProviderRefresh, retainedStore });
    } finally {
      harness.client.close();
      clearRuntimeAuthProfileStoreSnapshots();
      closeOpenClawStateDatabaseForTest();
      if (previousRegistry) {
        setActivePluginRegistry(previousRegistry);
      } else {
        resetPluginRuntimeStateForTest();
      }
    }
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
      credential: {
        type: "oauth",
        provider: "anthropic",
        access: "other-provider-access",
        refresh: "other-provider-refresh",
        expires: Date.now() + 24 * 60 * 60_000,
        accountId: ACCOUNT_ID,
      },
    },
  ] satisfies Array<{ name: string; credential: AuthProfileCredential | undefined }>)(
    "rejects a retained persisted OAuth profile when canonical authority $name",
    async ({ credential }) => {
      const refreshOAuth = vi.fn(async (current: OAuthCredential) => ({
        ...current,
        access: "retired-profile-rotated-access",
        refresh: "retired-profile-rotated-refresh",
        expires: Date.now() + 60_000,
        accountId: ACCOUNT_ID,
      }));

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

          harness.send({
            id: "refresh-authority-lost",
            method: "account/chatgptAuthTokens/refresh",
            params: { reason: "unauthorized", previousAccountId: ACCOUNT_ID },
          });
          const response = await waitForResponse(harness, "refresh-authority-lost");
          expect(response).toMatchObject({
            error: { code: -32603, message: expect.stringMatching(/no longer available/i) },
          });
          expect(response.result).toBeUndefined();
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
    const refreshOAuth = vi.fn(async (credential: OAuthCredential) => ({
      ...credential,
      access: "other-account-access",
      refresh: "other-account-refresh",
      expires: Date.now() + 60_000,
      accountId: "account-b",
    }));

    await withAuthRefreshHarness(refreshOAuth, async ({ harness }) => {
      harness.send({
        id: "refresh-rejected",
        method: "account/chatgptAuthTokens/refresh",
        params: { reason: "unauthorized", previousAccountId: ACCOUNT_ID },
      });
      const rejected = await waitForResponse(harness, "refresh-rejected");
      expect(rejected).toMatchObject({
        error: { code: -32603, message: expect.stringMatching(/different OAuth account/i) },
      });
      expect(rejected.result).toBeUndefined();

      harness.send({
        id: "refresh-after-fence",
        method: "account/chatgptAuthTokens/refresh",
        params: { reason: "unauthorized", previousAccountId: ACCOUNT_ID },
      });
      const afterFence = await waitForResponse(harness, "refresh-after-fence");
      expect(afterFence).toMatchObject({
        error: { code: -32603, message: expect.stringMatching(/sign in again/i) },
      });
      expect(afterFence.result).toBeUndefined();
      expect(refreshOAuth).toHaveBeenCalledTimes(1);

      const responses = JSON.stringify([rejected, afterFence]);
      expect(responses).not.toContain(INITIAL_ACCESS);
      expect(responses).not.toContain("other-account-access");
    });
  });

  it("returns and persists an accepted same-account rotation", async () => {
    const refreshOAuth = vi.fn(async (credential: OAuthCredential) => ({
      ...credential,
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: Date.now() + 60_000,
      accountId: ACCOUNT_ID,
    }));

    await withAuthRefreshHarness(refreshOAuth, async ({ agentDir, harness, retainedStore }) => {
      harness.send({
        id: "refresh-accepted",
        method: "account/chatgptAuthTokens/refresh",
        params: { reason: "unauthorized", previousAccountId: ACCOUNT_ID },
      });
      await expect(waitForResponse(harness, "refresh-accepted")).resolves.toEqual({
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
    });
  });
});
