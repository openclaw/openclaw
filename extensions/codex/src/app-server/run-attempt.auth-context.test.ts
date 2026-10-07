import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { itemNotification } from "./protocol.test-helpers.js";
import {
  createTestParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

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
      trigger: "cron",
      senderId: "must-not-leak",
      channelContext: { sender: { id: "must-not-leak" }, chat: { id: "must-not-leak" } },
    });
    for (const context of contexts) {
      expect(context).toMatchObject({
        accountId: "account-a",
        channel: "telegram",
        trigger: "cron",
      });
      for (const key of ["senderId", "chatId", "channelContext"]) {
        expect(context).not.toHaveProperty(key);
      }
    }
  });
});
