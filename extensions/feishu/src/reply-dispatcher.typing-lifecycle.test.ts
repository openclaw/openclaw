import { expect, it, vi } from "vitest";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import { installReplyRuntime } from "./reply-dispatcher.test-support.js";

const reaction = vi.hoisted(() => ({
  create: vi.fn(async () => ({ code: 0, data: { reaction_id: "owned-typing-reaction" } })),
  delete: vi.fn(async () => ({ code: 0 })),
}));

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createFeishuClient: () => ({ im: { messageReaction: reaction } }),
}));

it("keeps typing available after delivery idle until source cleanup", async () => {
  const restoreRuntime = installReplyRuntime();
  const { dispatcherOptions: lifecycle } = createFeishuReplyDispatcher({
    cfg: {
      channels: {
        feishu: {
          appId: "owned-typing-app",
          appSecret: "owned-fixture-secret",
          typingIndicator: true,
          renderMode: "auto",
          streaming: { mode: "off" },
        },
      },
    },
    agentId: "main",
    chatId: "oc_owned_chat",
    sendTarget: "oc_owned_chat",
    replyToMessageId: "om_parent",
    messageCreateTimeMs: Date.now(),
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  });
  try {
    await lifecycle.onIdle?.();
    await lifecycle.onReplyStart?.();
    await vi.waitFor(() => expect(reaction.create).toHaveBeenCalledOnce());
    expect(reaction.delete).not.toHaveBeenCalled();
    lifecycle.onCleanup?.();
    await vi.waitFor(() => expect(reaction.delete).toHaveBeenCalledOnce());
  } finally {
    lifecycle.onCleanup?.();
    restoreRuntime();
  }
});
