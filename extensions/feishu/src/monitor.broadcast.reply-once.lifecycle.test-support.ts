// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getFeishuLifecycleTestMocks,
  resetFeishuLifecycleTestMocks,
} from "./lifecycle.test-support.js";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { FeishuConfigSchema } from "./config-schema.js";
import {
  createFeishuTextMessageEvent,
  createFeishuLifecycleReplyDispatcher,
  installFeishuLifecycleReplyRuntime,
  mockFeishuReplyOnceDispatch,
  restoreFeishuLifecycleStateDir,
  runFeishuLifecycleSequence,
  setFeishuLifecycleStateDir,
  setupFeishuLifecycleHandler,
  stopFeishuLifecycleMonitors,
} from "./test-support/lifecycle-test-support.js";

const {
  createEventDispatcherMock,
  createFeishuReplyDispatcherMock,
  dispatchReplyFromConfigMock,
  resolveAgentRouteMock,
  resolveBoundConversationMock,
  withReplyDispatcherMock,
} = getFeishuLifecycleTestMocks();

const runtimesByAccount = new Map<string, RuntimeEnv>();
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const accountConfig = {
  enabled: true,
  connectionMode: "websocket",
  groupPolicy: "open",
  requireMention: false,
  resolveSenderNames: false,
  groups: { oc_broadcast_group: { requireMention: false } },
} as const;

const credentials = {
  "account-A": { appId: "cli_a", appSecret: "secret_a" }, // pragma: allowlist secret
  "account-B": { appId: "cli_b", appSecret: "secret_b" }, // pragma: allowlist secret
};

async function setupLifecycleMonitor(accountId: "account-A" | "account-B") {
  const runtime = createNonExitingRuntimeEnv();
  runtimesByAccount.set(accountId, runtime);
  return setupFeishuLifecycleHandler({
    createEventDispatcherMock,
    runtime,
    cfg: {
      broadcast: { oc_broadcast_group: ["susan", "main"] },
      agents: { entries: { main: {}, susan: {} } },
      channels: {
        feishu: {
          enabled: true,
          groupPolicy: "open",
          requireMention: false,
          resolveSenderNames: false,
          accounts: {
            "account-A": { ...accountConfig, ...credentials["account-A"] },
            "account-B": { ...accountConfig, ...credentials["account-B"] },
          },
        },
      },
      messages: { inbound: { debounceMs: 0, byChannel: { feishu: 0 } } },
    } as ClawdbotConfig,
    account: {
      accountId,
      enabled: true,
      configured: true,
      ...credentials[accountId],
      domain: "feishu",
      config: FeishuConfigSchema.parse(accountConfig),
    },
    handlerKey: "im.message.receive_v1",
    missingHandlerMessage: `missing im.message.receive_v1 handler for ${accountId}`,
    once: true,
  });
}

it("uses one active Feishu reply path when the same broadcast event reaches two accounts", async () => {
  onTestFinished(async () => {
    try {
      await stopFeishuLifecycleMonitors();
      restoreFeishuLifecycleStateDir(originalStateDir);
    } finally {
      vi.useRealTimers();
    }
  });
  vi.useRealTimers();
  resetFeishuLifecycleTestMocks();
  setFeishuLifecycleStateDir("openclaw-feishu-broadcast");

  createFeishuReplyDispatcherMock.mockReturnValue(createFeishuLifecycleReplyDispatcher());
  resolveBoundConversationMock.mockReturnValue(null);
  resolveAgentRouteMock.mockReturnValue({
    agentId: "main",
    channel: "feishu",
    accountId: "account-A",
    sessionKey: "agent:main:feishu:group:oc_broadcast_group",
    mainSessionKey: "agent:main:main",
    matchedBy: "default",
  });

  mockFeishuReplyOnceDispatch({
    dispatchReplyFromConfigMock,
    replyText: "broadcast reply once",
    shouldSendFinalReply: (ctx) =>
      typeof (ctx as { SessionKey?: string } | undefined)?.SessionKey === "string" &&
      (ctx as { SessionKey: string }).SessionKey.includes("agent:main:"),
  });

  installFeishuLifecycleReplyRuntime({
    resolveAgentRouteMock,
    dispatchReplyFromConfigMock,
    withReplyDispatcherMock,
    storePath: "/tmp/feishu-broadcast-sessions.json",
  });
  const onMessageA = await setupLifecycleMonitor("account-A");
  const onMessageB = await setupLifecycleMonitor("account-B");
  const event = createFeishuTextMessageEvent({
    messageId: "om_broadcast_once",
    chatId: "oc_broadcast_group",
    text: "hello broadcast",
  });

  await runFeishuLifecycleSequence(
    [() => onMessageA(event), () => onMessageB(event)],
    [
      () => {
        expect(dispatchReplyFromConfigMock.mock.calls.length).toBeGreaterThan(0);
      },
      () => {
        expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(2);
        expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
      },
    ],
  );

  expect(runtimesByAccount.get("account-A")?.error).not.toHaveBeenCalled();
  expect(runtimesByAccount.get("account-B")?.error).not.toHaveBeenCalled();

  expect(createFeishuReplyDispatcherMock).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: "account-a",
      chatId: "oc_broadcast_group",
      replyToMessageId: "om_broadcast_once",
    }),
  );

  const sessionKeys = dispatchReplyFromConfigMock.mock.calls.map(
    (call) => (call[0].ctx as { SessionKey?: string }).SessionKey,
  );
  expect(sessionKeys).toContain("agent:main:feishu:group:oc_broadcast_group");
  expect(sessionKeys).toContain("agent:susan:feishu:group:oc_broadcast_group");

  const active = createFeishuReplyDispatcherMock.mock.results[0]?.value as ReturnType<
    typeof createFeishuLifecycleReplyDispatcher
  >;
  expect(active.delivery.deliver).toHaveBeenCalledTimes(1);
});
