import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { createFeishuBotMenuHandler } from "./monitor.bot-menu-handler.js";

const handleFeishuMessageMock = vi.hoisted(() => vi.fn(async (_params?: unknown) => {}));
const parseFeishuMessageEventMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => ({ messageId: "m1", chatId: "c1" })),
);
const getMessageFeishuMock = vi.hoisted(() => vi.fn());

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const pendingTasks = new Set<Promise<void>>();

vi.mock("./bot.js", () => {
  return {
    handleFeishuMessage: handleFeishuMessageMock,
    parseFeishuMessageEvent: parseFeishuMessageEventMock,
  };
});

vi.mock("./send.js", () => {
  return {
    sendCardFeishu: sendCardFeishuMock,
    getMessageFeishu: getMessageFeishuMock,
  };
});

function createBotMenuEvent(params: { eventKey: string; timestamp: string }) {
  return {
    event_key: params.eventKey,
    timestamp: params.timestamp,
    operator: {
      operator_id: {
        open_id: "ou_user1",
        user_id: "user_1",
        union_id: "union_1",
      },
    },
  };
}

async function registerHandlers(params: { runtime?: RuntimeEnv } = {}) {
  const runtime = params.runtime ?? (createRuntimeSpies() as RuntimeEnv);
  return createFeishuBotMenuHandler({
    cfg: {} as ClawdbotConfig,
    accountId: "default",
    runtime,
    chatHistories: new Map(),
    fireAndForget: true,
    trackTask: (task) => {
      pendingTasks.add(task);
      void task.then(
        () => pendingTasks.delete(task),
        () => pendingTasks.delete(task),
      );
    },
    getBotOpenId: () => "ou_bot",
  });
}

function firstMockArg(mock: { mock: { calls: Array<readonly unknown[]> } }, label: string) {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

describe("Feishu bot menu handler", () => {
  afterAll(() => {
    vi.doUnmock("./bot.js");
    vi.doUnmock("./send.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENCLAW_STATE_DIR = `/tmp/openclaw-feishu-bot-menu-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(async () => {
    while (pendingTasks.size > 0) {
      await Promise.allSettled(pendingTasks);
    }
    await closeOpenClawStateDatabaseAsync();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
      return;
    }
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  });

  it("falls back to the legacy /menu synthetic message path for unrelated bot menu keys", async () => {
    const onBotMenu = await registerHandlers();

    await onBotMenu(createBotMenuEvent({ eventKey: "custom-key", timestamp: "1700000000002" }));

    expect(handleFeishuMessageMock).toHaveBeenCalledTimes(1);
    const handleArgs = firstMockArg(handleFeishuMessageMock, "Feishu synthetic message") as
      | { event?: { message?: { content?: string } } }
      | undefined;
    expect(handleArgs?.event?.message?.content).toBe('{"text":"/menu custom-key"}');
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
  });

  it("reopens replay for explicit retryable fallback failures", async () => {
    const runtime = createRuntimeSpies() as RuntimeEnv;
    const onBotMenu = await registerHandlers({ runtime });
    sendCardFeishuMock
      .mockImplementationOnce(async () => {
        throw new Error("boom");
      })
      .mockImplementationOnce(async () => {
        throw new Error("boom");
      });
    handleFeishuMessageMock
      .mockRejectedValueOnce(
        Object.assign(new Error("retry me"), {
          name: "FeishuRetryableSyntheticEventError",
        }),
      )
      .mockResolvedValueOnce(undefined);

    await onBotMenu(createBotMenuEvent({ eventKey: "quick-actions", timestamp: "1700000000004" }));
    await vi.waitFor(() => {
      expect(runtime.error).toHaveBeenCalledWith(
        "feishu[default]: error handling bot menu event: FeishuRetryableSyntheticEventError: retry me",
      );
    });
    await onBotMenu(createBotMenuEvent({ eventKey: "quick-actions", timestamp: "1700000000004" }));

    expect(sendCardFeishuMock).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => {
      expect(handleFeishuMessageMock).toHaveBeenCalledTimes(2);
    });
  });
});
