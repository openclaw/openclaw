import path from "node:path";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import * as authBridge from "./auth-bridge.js";
import { appInfo, pluginInstalled } from "./plugin-inventory.test-helpers.js";
import { buildPluginAppPolicyContext } from "./plugin-thread-config.js";
import { itemNotification } from "./protocol.test-helpers.js";
import {
  createTestParams,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { captureScheduledCodexAppAuthority } from "./scheduled-app-authority.js";
import { createScheduledAppAuthority } from "./scheduled-app-authority.test-support.js";
import { createCodexTestOAuthProfile } from "./test-support.js";

setupRunAttemptTestHooks();

function createScheduledParams(profileId: string, accountId: string) {
  const params = createTestParams();
  params.agentDir = path.join(tempDir, "agent");
  params.trigger = "cron";
  params.authProfileId = profileId;
  params.authProfileStore.profiles[profileId] = {
    ...createCodexTestOAuthProfile(accountId),
    // Stay outside the OAuth refresh window; this is an isolated synthetic account.
    expires: Date.now() + 24 * 60 * 60_000,
  };
  const runtimePlan = createCodexRuntimePlanFixture();
  params.runtimePlan = {
    ...runtimePlan,
    auth: {
      ...runtimePlan.auth,
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
      forwardedAuthProfileId: profileId,
      selectedAuthMode: "subscription",
      modelRoute: {
        provider: "openai",
        modelId: params.modelId,
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authRequirement: "subscription",
        requestTransportOverrides: "none",
      },
    },
  };
  return params;
}

async function compactWithHooks(overrides: Partial<ReturnType<typeof createTestParams>>) {
  const hooks = (["before_prompt_build", "before_compaction", "after_compaction"] as const).map(
    (hookName) => ({
      hookName,
      handler: vi.fn<(event: unknown, context: unknown) => undefined>(() => undefined),
    }),
  );
  initializeGlobalHookRunner(createMockPluginRegistry(hooks));
  const harness = createStartedThreadHarness();
  const params = Object.assign(createTestParams(), {
    messageChannel: "telegram",
    messageProvider: "telegram",
    currentChannelId: "telegram:-100123",
    agentAccountId: "account-a",
    ...overrides,
  });
  const run = runCodexAppServerAttempt(params);
  await run.waitForTurnAccepted();
  for (const method of ["item/started", "item/completed"] as const) {
    await harness.notify(itemNotification(method, { type: "contextCompaction", id: "compact-1" }));
  }
  await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  expect((await run).terminal).toEqual({ kind: "ok" });
  for (const { handler } of hooks) {
    expect(handler).toHaveBeenCalledOnce();
  }
  return hooks.map(({ handler }) => handler.mock.calls[0]?.[1]);
}

describe("runCodexAppServerAttempt authenticated hook context", () => {
  beforeEach(() => {
    // Cold worker startup must not spend the scenario's execution budget.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  });

  it.each([
    { name: "account", profileId: "openai:work", accountId: "acct-other" },
    { name: "profile", profileId: "openai:other", accountId: "acct-1" },
  ])(
    "rejects a scheduled $name mismatch before acquiring the app-server client",
    async (current) => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected external fetch"));
      const prepared = vi.spyOn(authBridge, "resolveCodexAppServerPreparedAuthHandoff");
      const acquireClient = vi.fn();
      const harness = createStartedThreadHarness(undefined, { onStart: acquireClient });
      const params = createScheduledParams(current.profileId, current.accountId);
      params.scheduledRuntimeAuthority = createScheduledAppAuthority();

      await expect(runCodexAppServerAttempt(params)).rejects.toThrow(
        "that exact prepared account is not active",
      );
      expect(prepared).toHaveBeenCalledOnce();
      await expect(prepared.mock.results[0]?.value).resolves.toMatchObject({
        preparedAuth: {
          kind: "profile",
          profileId: current.profileId,
          snapshot: { chatgptAccountId: current.accountId },
        },
      });
      expect(acquireClient).not.toHaveBeenCalled();
      expect(harness.requests).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "consumes captured read authority at scheduled startup (current policy revoked=%s)",
    async (revoked) => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected external fetch"));
      // Only the external app-server is simulated. Capture, account admission,
      // current-policy intersection, thread startup, and turn admission are real.
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "config/read") {
          return {
            config: { apps: { calendar: { enabled: true } } },
            layers: [],
          };
        }
        if (method === "app/installed" || method === "app/read") {
          return codexAppInventoryResponse(method, [appInfo("calendar", true)]);
        }
        if (method === "plugin/installed") {
          return pluginInstalled([]);
        }
        if (method === "mcpServerStatus/list") {
          return {
            data: [
              {
                name: "codex_apps",
                serverInfo: { name: "codex_apps", version: "1" },
                tools: {
                  read: {
                    _meta: { connector_id: "calendar" },
                    annotations: {
                      readOnlyHint: true,
                      destructiveHint: false,
                      openWorldHint: false,
                    },
                  },
                },
              },
            ],
            nextCursor: null,
          };
        }
        return undefined;
      });
      const captured = await captureScheduledCodexAppAuthority({
        client: harness.client,
        threadId: "creator-thread",
        policyContext: buildPluginAppPolicyContext(
          {
            calendar: {
              source: "account",
              appName: "Calendar",
              allowDestructiveActions: false,
              allowOpenWorld: false,
              destructiveApprovalMode: "ask",
              mcpServerNames: [],
            },
          },
          {},
        ),
        auth: { kind: "prepared-profile", profileId: "openai:work", accountId: "acct-1" },
      });
      expect(captured).toMatchObject({
        payload: { apps: [{ id: "calendar", tools: { read: "auto" } }] },
      });
      const params = createScheduledParams("openai:work", "acct-1");
      // Pass the actual capture result into a subsequent scheduled run.
      params.scheduledRuntimeAuthority = captured;
      const boundary = harness.requests.length;
      const run = runCodexAppServerAttempt(params, {
        pluginConfig: {
          codexPlugins: {
            enabled: !revoked,
            allow_all_plugins: true,
            allow_destructive_actions: "ask",
          },
        },
      });
      if (revoked) {
        await expect(run).rejects.toThrow(
          "Scheduled Codex apps are unavailable under the current policy or account: calendar",
        );
        expect(harness.requests.slice(boundary).some(({ method }) => method === "turn/start")).toBe(
          false,
        );
        expect(fetch).not.toHaveBeenCalled();
        return;
      }
      await run.waitForTurnAccepted();
      const threadStart = harness.requests
        .slice(boundary)
        .find(({ method }) => method === "thread/start");
      expect(threadStart?.params).toMatchObject({
        config: {
          apps: {
            calendar: { enabled: true, tools: { read: { enabled: true, approval_mode: "auto" } } },
          },
        },
      });
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      expect((await run).terminal).toEqual({ kind: "ok" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("preserves authenticated channel context across prompt and compaction hooks", async () => {
    const contexts = await compactWithHooks({
      sandboxSessionKey: "global",
      messageTo: "telegram:-100123",
      senderId: "sender-a",
      channelContext: {
        sender: { id: "stale-sender", profile: "sender-profile" },
        chat: { id: "stale-chat", thread: "chat-thread" },
      },
    });
    for (const context of contexts) {
      expect(context).toMatchObject({
        accountId: "account-a",
        channel: "telegram",
        sessionKey: "agent:main:session-1",
        messageProvider: "telegram",
        channelId: "-100123",
        chatId: "-100123",
        senderId: "sender-a",
        channelContext: {
          sender: { id: "sender-a", profile: "sender-profile" },
          chat: { id: "-100123", thread: "chat-thread" },
        },
      });
    }
  });

  it("omits sender and chat identity from non-user prompt and compaction hooks", async () => {
    const contexts = await compactWithHooks({
      trigger: "heartbeat",
      senderId: "must-not-leak",
      channelContext: { sender: { id: "must-not-leak" }, chat: { id: "must-not-leak" } },
    });
    for (const context of contexts) {
      expect(context).toMatchObject({
        accountId: "account-a",
        channel: "telegram",
        trigger: "heartbeat",
      });
      for (const key of ["senderId", "chatId", "channelContext"]) {
        expect(context).not.toHaveProperty(key);
      }
    }
  });
});
