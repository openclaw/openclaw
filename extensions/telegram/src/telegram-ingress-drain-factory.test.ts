import type {
  PluginHookBeforeChannelIngressEvent,
  PluginHookBeforeChannelIngressResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTelegramTransportIngressMonitor } from "./telegram-ingress-drain-factory.js";
import type { createTelegramIngressMonitor } from "./telegram-ingress-drain.js";

type Dispatch = Parameters<typeof createTelegramIngressMonitor>[0]["dispatch"];
const mocks = vi.hoisted(() => ({
  monitor: vi.fn(),
  prepare:
    vi.fn<
      (
        event: PluginHookBeforeChannelIngressEvent,
      ) => Promise<PluginHookBeforeChannelIngressResult | undefined>
    >(),
}));
vi.mock("./telegram-ingress-spool.js", () => ({ openTelegramIngressQueue: () => ({}) }));
vi.mock("./telegram-ingress-drain.js", () => ({
  createTelegramIngressMonitor: mocks.monitor,
  resolveTelegramAdoptionStallTimeoutMs: () => 300_000,
}));
vi.mock("openclaw/plugin-sdk/plugin-hook-runtime", () => ({
  getGlobalHookRunner: () => ({ hasHooks: () => true, runBeforeChannelIngress: mocks.prepare }),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({ readRuntimeConfig: () => ({}) }));

function fixture() {
  const controller = new AbortController();
  const lifecycle: Parameters<Dispatch>[1] = {
    abortSignal: controller.signal,
    onAdopted: vi.fn(),
    onDeferred: vi.fn(),
    onDeferredHeartbeat: vi.fn(),
    deferredHeartbeatIntervalMs: 100_000,
    onAdoptionFinalizing: vi.fn(),
    onFailed: vi.fn(),
    onCancelled: vi.fn(),
    onAbandoned: vi.fn(),
  };
  const update = {
    update_id: 42,
    message: {
      message_id: 21,
      from: { id: 111, is_bot: false },
      chat: { id: -222, type: "supergroup" },
      message_thread_id: 7,
      reply_to_message: { message_id: 20 },
      voice: { file_id: "synthetic-audio", file_unique_id: "synthetic-unique" },
      caption: "caption",
    },
  };
  const bot = { handleUpdate: vi.fn(async () => {}), api: { answerCallbackQuery: vi.fn() } };
  createTelegramTransportIngressMonitor({ bot, accountId: "account-a" });
  const dispatch: Dispatch = mocks.monitor.mock.calls[0][0].dispatch;
  return { update, bot, dispatch, lifecycle, controller };
}

describe("Telegram native ingress preparation", () => {
  beforeEach(() => {
    mocks.monitor.mockClear();
    mocks.prepare.mockReset();
  });

  it("awaits preparation before invoking middleware that downloads media", async () => {
    const preparation = createDeferred<PluginHookBeforeChannelIngressResult>();
    mocks.prepare.mockReturnValue(preparation.promise);
    const f = fixture();
    const originalMessage = f.update.message;
    const dispatched = f.dispatch(f.update, f.lifecycle);
    expect(f.bot.handleUpdate).not.toHaveBeenCalled();
    expect(f.lifecycle.onAdopted).not.toHaveBeenCalled();
    expect(f.lifecycle.onAdoptionFinalizing).not.toHaveBeenCalled();
    preparation.resolve({ text: "Accept the required terms first.", suppressAttachments: true });
    await dispatched;
    expect(f.bot.handleUpdate).toHaveBeenCalledWith(f.update);
    expect(f.update.message).toMatchObject({
      from: originalMessage.from,
      chat: originalMessage.chat,
      message_id: 21,
      message_thread_id: 7,
      reply_to_message: originalMessage.reply_to_message,
      text: "Accept the required terms first.",
    });
    expect(f.update.message).not.toHaveProperty("voice");
    expect(f.update.message).not.toHaveProperty("caption");
    expect(f.update.update_id).toBe(42);
    expect(originalMessage.voice.file_id).toBe("synthetic-audio");
  });

  it("ignores identity fields returned by a preparer", async () => {
    mocks.prepare.mockResolvedValue(
      Object.assign(
        { text: "Prepared", suppressAttachments: true },
        {
          from: { id: 999 },
          chat: { id: 999 },
          update_id: 999,
          message_id: 999,
        },
      ),
    );
    const f = fixture();
    await f.dispatch(f.update, f.lifecycle);
    expect(f.update.update_id).toBe(42);
    expect(f.update.message.from.id).toBe(111);
    expect(f.update.message.chat.id).toBe(-222);
    expect(f.update.message.message_id).toBe(21);
    expect(f.update.message.message_thread_id).toBe(7);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(f.update.message).toMatchObject({ text: "Prepared" });
  });

  it("keeps event-owned provider facts separate from the native transport update", async () => {
    const f = fixture();
    mocks.prepare.mockImplementation(async (...args) => {
      const event = args[0] as { providerUpdate: typeof f.update };
      event.providerUpdate.message.from.id = 999;
      event.providerUpdate.message.chat.id = 999;
      event.providerUpdate.message.voice.file_id = "changed";
      return undefined;
    });
    await f.dispatch(f.update, f.lifecycle);
    expect(f.bot.handleUpdate).toHaveBeenCalledWith(f.update);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(f.update.message.from.id).toBe(111);
    expect(f.update.message.chat.id).toBe(-222);
    expect(f.update.message.voice.file_id).toBe("synthetic-audio");
  });

  it("projects edited-message caption, reply and bot facts while preserving native context", async () => {
    const f = fixture();
    const edit = { update_id: 43, edited_message: f.update.message };
    mocks.prepare.mockImplementation(async (event) => {
      expect(event.providerUpdate).toMatchObject({
        update_id: 43,
        edited_message: {
          from: { id: 111, is_bot: false },
          chat: { id: -222, type: "supergroup" },
          message_id: 21,
          message_thread_id: 7,
          caption: "caption",
          reply_to_message: { message_id: 20 },
          voice: { file_id: "synthetic-audio", file_unique_id: "synthetic-unique" },
        },
      });
      return { text: "Edited prepared text", suppressAttachments: true };
    });
    await f.dispatch(edit, f.lifecycle);
    expect(edit.edited_message).toMatchObject({
      text: "Edited prepared text",
      from: f.update.message.from,
      chat: f.update.message.chat,
      reply_to_message: f.update.message.reply_to_message,
      message_thread_id: 7,
    });
    expect(edit.edited_message).not.toHaveProperty("voice");
    expect(f.bot.handleUpdate).toHaveBeenCalledWith(edit);
  });

  it("clears caption entities when changing text while retaining attachments", async () => {
    const f = fixture();
    Object.assign(f.update.message, {
      caption_entities: [
        { type: "text_link", offset: 0, length: 3, url: "https://example.com/old" },
      ],
    });
    mocks.prepare.mockResolvedValue({ text: "Prepared text" });
    await f.dispatch(f.update, f.lifecycle);
    expect(f.update.message).toMatchObject({
      text: "Prepared text",
      voice: { file_id: "synthetic-audio" },
    });
    expect(f.update.message).not.toHaveProperty("entities");
    expect(f.update.message).not.toHaveProperty("caption_entities");
  });

  it("removes album membership when attachments are intentionally suppressed", async () => {
    const f = fixture();
    Object.assign(f.update.message, { media_group_id: "synthetic-album" });
    mocks.prepare.mockResolvedValue({ text: "Prepared album text", suppressAttachments: true });
    await f.dispatch(f.update, f.lifecycle);
    expect(f.update.message).toMatchObject({ text: "Prepared album text" });
    expect(f.update.message).not.toHaveProperty("media_group_id");
    expect(f.update.message).not.toHaveProperty("voice");
    expect(f.bot.handleUpdate).toHaveBeenCalledWith(f.update);
  });

  it("rejects late prepared text after the native owner aborts", async () => {
    const preparation = createDeferred<PluginHookBeforeChannelIngressResult>();
    mocks.prepare.mockReturnValue(preparation.promise);
    const f = fixture();
    const dispatched = f.dispatch(f.update, f.lifecycle);
    f.controller.abort(new Error("owner cancelled"));
    preparation.resolve({ text: "Late transcription", suppressAttachments: true });
    await expect(dispatched).rejects.toThrow("owner cancelled");
    expect(f.lifecycle.onCancelled).toHaveBeenCalledOnce();
    expect(f.lifecycle.onAdopted).not.toHaveBeenCalled();
    expect(f.bot.handleUpdate).not.toHaveBeenCalled();
    expect(f.update.message).toHaveProperty("voice");
  });

  it("propagates preparation failure to the native retry owner before download", async () => {
    mocks.prepare.mockRejectedValue(new Error("transcript pending"));
    const f = fixture();
    await expect(f.dispatch(f.update, f.lifecycle)).rejects.toThrow("transcript pending");
    expect(f.lifecycle.onCancelled).not.toHaveBeenCalled();
    expect(f.bot.handleUpdate).not.toHaveBeenCalled();
    expect(f.lifecycle.onAdopted).not.toHaveBeenCalled();
  });
});
