import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { createFeishuBotMenuHandler } from "./monitor.bot-menu-handler.js";

const handleFeishuMessageMock = vi.hoisted(() => vi.fn(async (_params?: unknown) => {}));
const sendCardFeishuMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => ({ messageId: "m1", chatId: "c1" })),
);

const pendingTasks = new Set<Promise<void>>();

// mock-isolation: Observe menu dispatch without booting the channel message runtime.
vi.mock("./bot.js", () => ({
  handleFeishuMessage: handleFeishuMessageMock,
  parseFeishuMessageEvent: vi.fn(),
}));

// mock-isolation: Capture card sends without contacting Feishu.
vi.mock("./send.js", () => ({
  sendCardFeishu: sendCardFeishuMock,
  getMessageFeishu: vi.fn(),
}));

function createBotMenuEvent(event_key: string, timestamp: string) {
  return {
    event_key,
    timestamp,
    operator: { operator_id: { open_id: "ou_user1", user_id: "user_1", union_id: "union_1" } },
  };
}

function registerHandlers(runtime = createRuntimeSpies()) {
  return createFeishuBotMenuHandler({
    cfg: {},
    accountId: "default",
    runtime,
    chatHistories: new Map(),
    fireAndForget: true,
    trackTask: (task) => {
      pendingTasks.add(task);
      const done = () => pendingTasks.delete(task);
      void task.then(done, done);
    },
    getBotOpenId: () => "ou_bot",
  });
}

afterAll(() => {
  vi.doUnmock("./bot.js");
  vi.doUnmock("./send.js");
  vi.resetModules();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_STATE_DIR", `/tmp/feishu-menu-${Date.now()}-${Math.random()}`);
});

afterEach(async () => {
  while (pendingTasks.size > 0) {
    await Promise.allSettled(pendingTasks);
  }
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
});

it("falls back to the legacy /menu synthetic message path for unrelated bot menu keys", async () => {
  const onBotMenu = registerHandlers();
  await onBotMenu(createBotMenuEvent("custom-key", "1700000000002"));

  expect(handleFeishuMessageMock).toHaveBeenCalledTimes(1);
  expect(handleFeishuMessageMock.mock.calls[0]?.[0]).toMatchObject({
    event: { message: { content: '{"text":"/menu custom-key"}' } },
  });
  expect(sendCardFeishuMock).not.toHaveBeenCalled();
});

it("reports a fallback failure without reopening the committed menu event", async () => {
  const runtime = createRuntimeSpies();
  const onBotMenu = registerHandlers(runtime);
  const event = createBotMenuEvent("quick-actions", "1700000000004");
  sendCardFeishuMock.mockRejectedValueOnce(new Error("launcher unavailable"));
  handleFeishuMessageMock.mockRejectedValueOnce(new Error("fallback failed"));

  await onBotMenu(event);
  await Promise.allSettled(pendingTasks);
  expect(runtime.error).toHaveBeenCalledWith(
    "feishu[default]: error handling bot menu event: Error: fallback failed",
  );
  await onBotMenu(event);

  expect(sendCardFeishuMock).toHaveBeenCalledOnce();
  expect(handleFeishuMessageMock).toHaveBeenCalledOnce();
});
