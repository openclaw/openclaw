import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import { installReplyRuntime } from "./reply-dispatcher.test-support.js";

const message = vi.hoisted(() => ({
  create: vi.fn(async () => ({ code: 0, data: { message_id: "om_model_wait" } })),
  delete: vi.fn(async () => ({ code: 0 })),
}));

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createFeishuClient: () => ({ im: { message } }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["", "Earlier answer."])(
  "retracts a model wait before fallback with prior text=%j",
  async (previousText) => {
    const publishedTexts: unknown[] = [];
    vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async ({ url, init }) => {
      const path = new URL(url).pathname;
      if (typeof init?.body !== "string") {
        throw new Error("Expected a serialized Feishu request body");
      }
      const body: Record<string, unknown> = JSON.parse(init.body);
      if (path.endsWith("/elements/content/content")) {
        publishedTexts.push(body.content);
      }
      const data = path.includes("/auth/")
        ? { tenant_access_token: "owned-fixture-token", expire: 7200 }
        : { data: { card_id: "owned-model-wait-card" } };
      return {
        response: Response.json({ code: 0, ...data }),
        finalUrl: url,
        release: async () => {},
      };
    });
    const restoreRuntime = installReplyRuntime();
    const feishu = {
      appId: `owned-model-wait-${Boolean(previousText)}`,
      appSecret: "owned-fixture-secret",
      typingIndicator: false,
      renderMode: "card",
      streaming: { mode: "partial" },
    };
    const { dispatcherOptions: lifecycle, replyOptions: reply } = createFeishuReplyDispatcher({
      cfg: { channels: { feishu } },
      agentId: "main",
      chatId: "oc_owned_chat",
      sendTarget: "oc_owned_chat",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    const waitItem = { itemId: "wait", kind: "model-wait", suppressDurableProgress: true } as const;
    try {
      await lifecycle.onReplyStart?.();
      if (previousText) {
        reply.onPartialReply?.({ text: previousText });
        await reply.onItemEvent?.({
          itemId: "existing-work",
          kind: "tool",
          title: "Checking fixtures",
          progressText: "Looking up records",
        });
        await vi.advanceTimersByTimeAsync(160);
        expect(publishedTexts.at(-1)).toContain(previousText);
        expect(publishedTexts.at(-1)).toContain("Looking up records");
      }
      const waitText = "Waiting for the local model to respond";
      await reply.onItemEvent?.({ ...waitItem, phase: "update", progressText: waitText });
      await vi.advanceTimersByTimeAsync(160);
      expect(publishedTexts.at(-1)).toContain(waitText);

      await reply.onItemEvent?.({ ...waitItem, phase: "end" });
      reply.onModelSelected?.({
        provider: "openai",
        model: "owned-fallback-model",
        thinkLevel: undefined,
      });
      await vi.advanceTimersByTimeAsync(160);
      if (previousText) {
        expect(publishedTexts.at(-1)).toContain(previousText);
        expect(publishedTexts.at(-1)).toContain("Looking up records");
        expect(publishedTexts.at(-1)).not.toContain(waitText);
        expect(message.delete).not.toHaveBeenCalled();
      } else {
        expect(message.delete).toHaveBeenCalledExactlyOnceWith({
          path: { message_id: "om_model_wait" },
        });
      }
    } finally {
      await lifecycle.onIdle?.();
      lifecycle.onCleanup?.();
      restoreRuntime();
    }
  },
);
