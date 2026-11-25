// Covers explicit card rendering for completed blocks when preview streaming is off.
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import { installReplyRuntime } from "./reply-dispatcher.test-support.js";

const createMessage = vi.hoisted(() =>
  vi.fn(async (_request: { data: { msg_type: string } }) => ({
    code: 0,
    data: { message_id: "om_reply" },
  })),
);
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createFeishuClient: () => ({ im: { message: { create: createMessage } } }),
}));

let restoreRuntime: () => void;
beforeAll(() => {
  restoreRuntime = installReplyRuntime();
});
afterAll(() => restoreRuntime());

it("sends explicit-card blocks as static cards and keeps the table-limit post fallback", async () => {
  const plan = createFeishuReplyDispatcher({
    cfg: {
      channels: {
        feishu: {
          appId: "test-app",
          appSecret: "test-secret",
          renderMode: "card",
          streaming: { mode: "off", block: { enabled: true } },
        },
      },
    },
    agentId: "agent",
    chatId: "oc_chat",
    sendTarget: "oc_chat",
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  });
  const dispatcher = createReplyDispatcher({ ...plan.dispatcherOptions, ...plan.delivery });
  const tables = Array.from({ length: 6 }, (_, i) => `| a${i} |\n| - |\n| ${i} |`).join("\n\n");
  dispatcher.sendBlockReply({ text: "First paragraph." });
  dispatcher.sendBlockReply({ text: tables });
  dispatcher.markComplete();
  await dispatcher.waitForIdle();

  expect(createMessage.mock.calls.map(([request]) => request.data.msg_type)).toEqual([
    "interactive",
    "post",
  ]);
});
