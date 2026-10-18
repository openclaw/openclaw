import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import { AUTH_PROFILE_RUNTIME_CONTRACT as contract } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import {
  createAppServerHarness,
  createCodexRuntimePlanFixture,
  createParams as createSharedParams,
  runCodexAppServerAttempt as runSharedAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding as writeRawCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import type { CodexAppServerClientOptions } from "./shared-client.js";
import { createCodexTestOAuthProfile } from "./test-support.js";

function runAttempt(
  params: EmbeddedRunAttemptParams,
  options: Parameters<typeof runSharedAttempt>[1] = {},
) {
  setRuntimeConfigSnapshot(params.config ?? {});
  return runSharedAttempt(params, options);
}

function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  const params = createSharedParams(sessionFile, workspaceDir, {
    prompt: contract.workspacePrompt,
    sessionId: contract.sessionId,
    sessionKey: contract.sessionKey,
    runId: contract.runId,
    provider: contract.codexHarnessProvider,
  });
  delete params.contextTokenBudget;
  delete params.contextWindowInfo;
  delete params.observeToolTerminal;
  return params;
}

function oauthProfile(access: string, lifetime = 60 * 60_000, refresh = "refresh-token") {
  return {
    type: "oauth" as const,
    provider: "openai",
    access,
    refresh,
    expires: Date.now() + lifetime,
  };
}

async function completeRun(harness: ReturnType<typeof createAuthHarness>, run: Promise<unknown>) {
  await harness.waitForMethod("turn/start");
  await harness.completeTurn();
  await run;
}

async function waitForClient(harness: ReturnType<typeof createAuthHarness>) {
  await vi.waitFor(() => expect(harness.seenClientOptions).toHaveLength(1), APP_SERVER_START_WAIT);
  return harness.seenClientOptions[0];
}

function subscriptionStore(lifetime = 60 * 60_000) {
  return {
    version: 1,
    profiles: { "openai:chatgpt": oauthProfile("subscription-token", lifetime) },
    order: { openai: ["openai:chatgpt"] },
  };
}

function createChatgptAccessToken(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `e30.${payload}.test-signature`;
}

function setPreparedOpenAIRoute(
  params: EmbeddedRunAttemptParams,
  authRequirement: "api-key" | "subscription",
  forwardedAuthProfileId?: string,
): void {
  const runtimePlan = createCodexRuntimePlanFixture();
  params.runtimePlan = {
    ...runtimePlan,
    auth: {
      ...runtimePlan.auth,
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
      selectedAuthMode: authRequirement,
      ...(forwardedAuthProfileId ? { forwardedAuthProfileId } : {}),
      modelRoute: {
        provider: "openai",
        modelId: "gpt-5.4-codex",
        api: authRequirement === "api-key" ? "openai-responses" : "openai-chatgpt-responses",
        baseUrl:
          authRequirement === "api-key"
            ? "https://api.openai.com/v1"
            : "https://chatgpt.com/backend-api/codex",
        authRequirement,
        requestTransportOverrides: "none",
      },
    },
  };
}

const DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT = JSON.stringify({
  "features.standalone_web_search": false,
  web_search: "disabled",
});
const APP_SERVER_START_WAIT = { interval: 1, timeout: 5_000 } as const;

async function bindProfile(authProfileId: string, dynamicToolsFingerprint?: string) {
  await seedRunSessionOwnerForTest(contract.sessionId, contract.sessionKey);
  return writeRawCodexAppServerBinding(sessionFile, {
    threadId: "thread-auth-contract",
    cwd: tempDir,
    authProfileId,
    webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
    ...(dynamicToolsFingerprint ? { dynamicToolsFingerprint } : {}),
  });
}

function createAuthHarness(
  params: {
    startMethod: "thread/start" | "thread/resume";
    persistedThreads?: string[];
  } = { startMethod: "thread/start" },
) {
  const seenAuthProfileIds: Array<string | undefined> = [];
  const seenClientOptions: CodexAppServerClientOptions[] = [];
  const harness = createAppServerHarness(
    async (method) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === params.startMethod) {
        return threadStartResult("thread-auth-contract", { cwd: "" });
      }
      if (method === "turn/start") {
        return turnStartResult("turn-auth-contract");
      }
      throw new Error(`unexpected method: ${method}`);
    },
    {
      persistedThreads: params.persistedThreads,
      onStart(authProfileId, _agentDir, options) {
        seenAuthProfileIds.push(authProfileId);
        if (options) {
          seenClientOptions.push(options);
        }
      },
    },
  );
  return {
    ...harness,
    seenAuthProfileIds,
    seenClientOptions,
    completeTurn: () =>
      harness.completeTurn({
        threadId: "thread-auth-contract",
        turnId: "turn-auth-contract",
      }),
  };
}

setupRunAttemptTestHooks();
afterEach(() => clearRuntimeConfigSnapshot());

let sessionFile: string;
let params: EmbeddedRunAttemptParams;

beforeEach(() => {
  sessionFile = path.join(tempDir, "session.jsonl");
  params = createParams(sessionFile, tempDir);
});

it("rejects a missing bound auth profile before app-server startup", async () => {
  await bindProfile("openai:missing");
  const clientFactory = vi.fn(async () => {
    throw new Error("unexpected app-server startup");
  });
  const rejection = await runAttempt(params, { clientFactory }).catch((error: unknown) => error);
  expect(rejection).toBeInstanceOf(Error);
  expect(rejection).toMatchObject({
    code: "selected_auth_profile_unavailable",
    message: expect.stringContaining(
      'auth profile "openai:missing" was not found in the OpenClaw credential store.',
    ),
  });
  expect(rejection).not.toHaveProperty("status");
  expect(clientFactory).not.toHaveBeenCalled();
});

it("reuses a bound OpenAI Codex auth profile when resume params omit authProfileId", async () => {
  const harness = createAuthHarness({
    startMethod: "thread/resume",
    persistedThreads: ["thread-auth-contract"],
  });
  await bindProfile(contract.openAiCodexProfileId, "[]");

  params.authProfileStore.profiles[contract.openAiCodexProfileId] =
    createCodexTestOAuthProfile("synthetic-account");

  const run = runAttempt(params);
  await vi.waitFor(
    () => expect(harness.seenAuthProfileIds).toEqual([contract.openAiCodexProfileId]),
    APP_SERVER_START_WAIT,
  );
  await completeRun(harness, run);
});

it("locks a prepared Platform route to its resolved API key", async () => {
  const harness = createAuthHarness();
  params.agentDir = tempDir;
  params.resolvedApiKey = "prepared-platform-key";
  params.authProfileStore = subscriptionStore();
  setPreparedOpenAIRoute(params, "api-key");

  const run = runAttempt(params);
  const clientOptions = await waitForClient(harness);
  expect(clientOptions).toMatchObject({
    preparedAuth: {
      kind: "api-key",
      apiKey: "prepared-platform-key",
    },
  });
  expect(clientOptions).not.toHaveProperty("authProfileId");
  await completeRun(harness, run);

  const binding = await readCodexAppServerBinding(sessionFile);
  expect(binding?.authProfileId).toBeUndefined();
});

it.each(["oauth", "token"] as const)(
  "locks a prepared subscription route to its forwarded %s profile",
  async (kind) => {
    const harness = createAuthHarness();
    const profileId = kind === "oauth" ? "openai:chatgpt" : "openai:token";
    const accountId = `account-${kind}`;
    const token = createChatgptAccessToken(accountId);
    const credential =
      kind === "oauth"
        ? { ...oauthProfile(token), accountId }
        : { type: "token" as const, provider: "openai", token };
    const authProfileStore = { version: 1, profiles: { [profileId]: credential } };
    params.authProfileStore = authProfileStore;
    setPreparedOpenAIRoute(params, "subscription", profileId);
    const run = runAttempt(params);
    const clientOptions = await waitForClient(harness);
    expect(clientOptions).toMatchObject({
      preparedAuth: {
        kind: "profile",
        profileId,
        store: authProfileStore,
        snapshot: { loginParams: { type: "chatgptAuthTokens", chatgptAccountId: accountId } },
      },
    });
    if (kind === "oauth") {
      expect(clientOptions).not.toHaveProperty("authProfileId");
    }
    await completeRun(harness, run);
  },
);

it("keeps a user-home app-server on native auth despite a prepared Platform route", async () => {
  const harness = createAuthHarness();
  params.agentDir = tempDir;
  params.authProfileStore = subscriptionStore();
  setPreparedOpenAIRoute(params, "api-key", "openai:chatgpt");

  const run = runAttempt(params, {
    pluginConfig: {
      appServer: { homeScope: "user" },
      supervision: { enabled: true },
    },
  });
  const clientOptions = await waitForClient(harness);
  expect(clientOptions).not.toHaveProperty("preparedAuth");
  expect(clientOptions).toMatchObject({
    startOptions: { homeScope: "user" },
  });
  await completeRun(harness, run);
});

it("fails before profile selection when a prepared Platform route has no key", async () => {
  const harness = createAuthHarness();
  params.authProfileStore = subscriptionStore(60_000);
  setPreparedOpenAIRoute(params, "api-key");

  await expect(runAttempt(params)).rejects.toThrow(
    "Prepared Codex API-key route is missing its resolved API key.",
  );
  expect(harness.seenClientOptions).toHaveLength(0);
});

it("rejects ambient auth before a remote-exec attempt starts", async () => {
  const harness = createAuthHarness();
  vi.stubEnv("CODEX_API_KEY", "ambient-codex-key");
  vi.stubEnv("OPENAI_API_KEY", "ambient-openai-key");
  params.authProfileStore = { version: 1, profiles: {} };
  params.sandbox = {
    ...createSandboxContext({}),
    placementExecutionMode: "remote-exec",
  } as NonNullable<typeof params.sandbox> & { placementExecutionMode: "remote-exec" };

  await expect(runAttempt(params)).rejects.toThrow(
    "Codex remote-exec cloud placement requires prepared OpenAI auth",
  );
  expect(harness.seenClientOptions).toHaveLength(0);
});

it("rejects a subscription route with an API-key profile", async () => {
  const harness = createAuthHarness();
  vi.stubEnv("OPENAI_API_KEY", "ambient-platform-key");
  vi.stubEnv("CODEX_ACCESS_TOKEN", "ambient-subscription-token");
  params.authProfileStore = {
    version: 1,
    profiles: {
      "openai:platform": {
        type: "api_key",
        provider: "openai",
        key: "platform-profile-key",
      },
      "openai:decoy": oauthProfile("decoy-subscription-token", 60_000, "decoy-refresh-token"),
    },
  };
  setPreparedOpenAIRoute(params, "subscription", "openai:platform");

  await expect(runAttempt(params)).rejects.toThrow(
    "Prepared Codex subscription route requires a forwarded OpenAI OAuth or token profile.",
  );
  expect(harness.seenClientOptions).toHaveLength(0);
});
