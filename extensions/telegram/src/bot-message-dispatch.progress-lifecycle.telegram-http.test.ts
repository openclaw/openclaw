import type { PluginHookReplyPayloadSendingEvent } from "openclaw/plugin-sdk/core";
import {
  addTestHook,
  createEmptyPluginRegistry,
  initializeGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { createNonExitingRuntime } from "openclaw/plugin-sdk/runtime-env";
import * as webMedia from "openclaw/plugin-sdk/web-media";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import type { ReplyResolverOptions } from "./bot-message-dispatch.telegram-http.test-support.js";
import { createTelegramDispatchHttpFixture } from "./bot-message-dispatch.telegram-http.test-support.js";
import { deliverReplies, deliverStructuredReplies } from "./bot/delivery.replies.js";
import { resolveTelegramTestUpload } from "./send.telegram-http.test-support.js";

const DELIVERY_WARNING =
  "I couldn't confirm the reply reached Telegram. Check OpenClaw chat history for the answer before retrying the task.";
const DELIVERY_WARNING_PREFIX = "I couldn't confirm the reply reached Telegram.";

describe("Telegram progress custody and delivery outcomes through HTTP", () => {
  const http = createTelegramDispatchHttpFixture();
  const {
    calls,
    visibleMessages,
    visibleMarkup,
    acceptedCalls,
    emitToolStart,
    dispatchProgressTurn,
    waitForBotApiCall,
  } = http;
  afterEach(() => vi.restoreAllMocks());

  it.each(["rejected", "no-message-id"] as const)(
    "keeps continuation custody local after a %s provider response",
    async (response) => {
      let adopted = false;
      http.respondToCall = (call) =>
        call.method === "sendMessage" && String(call.fields.text).includes("Pending delegation")
          ? response === "no-message-id"
            ? response
            : { error_code: 400, description: "Bad Request: progress rejected" }
          : undefined;
      await dispatchProgressTurn(
        async (options) => {
          await options?.onItemEvent?.({
            kind: "preamble",
            itemId: "pending-parent",
            phase: "end",
            progressText: "Pending delegation",
          });
        },
        {
          mode: "progress",
          toolProgress: true,
          finalReply: setReplyPayloadMetadata(
            { text: "Waiting for delegated work." },
            {
              progressContinuation: {
                adopt: async () => {
                  adopted = true;
                  return true;
                },
                close: () => undefined,
              },
            },
          ),
        },
      );
      expect(adopted).toBe(false);
      expect([...visibleMessages.values()]).toEqual(["Waiting for delegated work."]);
      expect(calls.some((call) => String(call.fields.text).includes("Pending delegation"))).toBe(
        true,
      );
    },
  );

  it("settles an empty final after a hook without a fallback", async () => {
    const registry = createEmptyPluginRegistry();
    addTestHook({
      registry,
      pluginId: "http-outcome-policy",
      hookName: "reply_payload_sending",
      handler: (event: PluginHookReplyPayloadSendingEvent) =>
        event.payload.text === "empty-hook"
          ? { payload: { ...event.payload, text: "" } }
          : undefined,
    });
    initializeGlobalHookRunner(registry);
    await dispatchProgressTurn(async () => undefined, {
      mode: "off",
      toolProgress: true,
      textLimit: 80,
      producer: async ({ dispatcher }) => {
        dispatcher.sendFinalReply({ text: "empty-hook" });
        const counts = dispatcher.getQueuedCounts();
        return { queuedFinal: counts.final > 0, counts };
      },
      allowErrors: true,
    });
    expect(
      calls.filter(
        (call) =>
          call.method === "sendMessage" &&
          String(call.fields.text).startsWith(DELIVERY_WARNING_PREFIX),
      ),
    ).toHaveLength(0);
    expect(JSON.stringify(acceptedCalls)).not.toContain("cancel");
    expect([...visibleMessages.values()]).toEqual([]);
  });

  it("delivers the final answer through repeated Telegram flood waits", async () => {
    const floodedAt: number[] = [];
    let flooded = Promise.withResolvers<void>();
    http.respondToCall = (call) => {
      if (
        call.method !== "sendMessage" ||
        call.fields.text !== "The command failed." ||
        floodedAt.length >= 3
      ) {
        return undefined;
      }
      floodedAt.push(Date.now());
      flooded.resolve();
      return {
        error_code: 429,
        description: "Too Many Requests: retry after 5",
        parameters: { retry_after: 5 },
      };
    };
    const turn = dispatchProgressTurn(
      async (options) => {
        await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "flood" });
        await waitForBotApiCall((call) => call.method === "sendMessage");
      },
      { mode: "progress", toolProgress: true, allowErrors: true },
    );
    for (let flood = 0; flood < 3; flood += 1) {
      await flooded.promise;
      flooded = Promise.withResolvers<void>();
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await turn;

    expect(floodedAt).toHaveLength(3);
    expect(floodedAt[2]! - floodedAt[0]!).toBeGreaterThanOrEqual(10_000);
    expect([...visibleMessages.values()]).toEqual(["The command failed."]);
    expect(calls.some((call) => String(call.fields.text).startsWith(DELIVERY_WARNING_PREFIX))).toBe(
      false,
    );
  });

  it("preserves a post-progress error final when Telegram rejects cleanup", async () => {
    http.respondToCall = (call) =>
      call.method === "deleteMessage"
        ? { error_code: 400, description: "Bad Request: progress cleanup rejected" }
        : undefined;
    await dispatchProgressTurn(
      async (options) => {
        await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "cleanup" });
        await waitForBotApiCall((call) => call.method === "sendMessage");
      },
      {
        mode: "progress",
        toolProgress: true,
        textLimit: 80,
        finalReply: { text: "A".repeat(80) + "B".repeat(40), isError: true },
      },
    );
    await vi.advanceTimersByTimeAsync(4_100);
    await waitForBotApiCall((call) => call.method === "deleteMessage");
    expect([...visibleMessages.values()].slice(1)).toEqual(["A".repeat(80), "B".repeat(40)]);
    expect(
      calls.filter((call) => call.fields.text === "No response generated. Please try again."),
    ).toEqual([]);
  });

  it.each([true, false])(
    "retains the existing progress card only when continuation custody is accepted (%s)",
    async (accept) => {
      const waitingText = "Waiting for delegated work.";
      const commentary = "Parent commentary remains visible.";
      const plan = [
        { step: "Inspect the request", status: "completed" as const },
        { step: "Finish delegated work", status: "in_progress" as const },
      ];
      let receipt: unknown;
      let progressMessageId: number | undefined;
      let parentCallbacks: ReplyResolverOptions | undefined;
      const waitingPayload = setReplyPayloadMetadata(
        { text: waitingText },
        {
          progressContinuation: {
            adopt: async (candidate) => {
              receipt = candidate;
              return accept;
            },
            close: () => undefined,
          },
        },
      );
      await dispatchProgressTurn(
        async (options) => {
          parentCallbacks = options;
          await options?.onPlanUpdate?.({
            phase: "update",
            explanation: "Delegating the remaining work",
            steps: plan,
          });
          await options?.onItemEvent?.({
            kind: "preamble",
            itemId: "parent-commentary",
            phase: "end",
            progressText: commentary,
          });
          await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "delegate" });
          await waitForBotApiCall((call) => call.method === "sendMessage");
          progressMessageId = [...visibleMessages.keys()][0];
        },
        { mode: "progress", toolProgress: true, finalReply: waitingPayload },
      );

      expect(receipt).toMatchObject({
        messageId: String(progressMessageId),
        text: expect.stringContaining(commentary),
        snapshot: { statusHeadline: commentary, plan },
      });
      if (accept) {
        await parentCallbacks?.onItemEvent?.({
          kind: "preamble",
          itemId: "parent-commentary",
          phase: "end",
          progressText: "A retired parent must not replace the retained card.",
        });
        await parentCallbacks?.onPlanUpdate?.({ phase: "update", steps: [] });
        await parentCallbacks?.onQueuedFollowupSettled?.();
      }
      // Advance detached preview cleanup beyond its four-second dwell.
      await vi.advanceTimersByTimeAsync(4_100);
      if (!accept) {
        await expect
          .poll(() => [...visibleMessages.values()], { timeout: 5_000 })
          .toEqual([waitingText]);
        expect(
          calls
            .filter((call) => call.method === "deleteMessage")
            .map((call) => Number(call.fields.message_id)),
        ).toEqual([progressMessageId]);
        return;
      }
      expect([...visibleMessages.entries()]).toEqual([
        [progressMessageId, expect.stringContaining(commentary)],
      ]);
      expect([...visibleMessages.values()][0]).toContain("Finish delegated work");
      expect(calls.filter((call) => call.method === "deleteMessage")).toEqual([]);
      expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
      expect(calls.some((call) => call.fields.text === waitingText)).toBe(false);
    },
  );

  it.each(["media", "buttons"] as const)(
    "delivers continuation %s instead of swallowing it in card adoption",
    async (content) => {
      let adopted = false;
      if (content === "media") {
        vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
          buffer: Buffer.from("delegated report bytes"),
          contentType: "application/pdf",
          kind: undefined,
          fileName: "report.pdf",
        });
      }
      await dispatchProgressTurn(
        async (options) => {
          await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "delegate" });
          await waitForBotApiCall((call) => call.method === "sendMessage");
        },
        {
          mode: "progress",
          toolProgress: true,
          finalReply: setReplyPayloadMetadata<ReplyPayload>(
            {
              text: "Waiting for delegated work.",
              ...(content === "media"
                ? { mediaUrl: "https://example.test/report.pdf" }
                : {
                    interactive: {
                      blocks: [{ type: "buttons", buttons: [{ label: "Continue", value: "go" }] }],
                    },
                  }),
            },
            {
              progressContinuation: {
                adopt: async () => {
                  adopted = true;
                  return true;
                },
                close: () => undefined,
              },
            },
          ),
        },
      );
      expect(adopted).toBe(false);
      if (content === "media") {
        const document = acceptedCalls.find((call) => call.method === "sendDocument");
        const upload = resolveTelegramTestUpload(document!.fields, "document");
        expect(await upload.text()).toBe("delegated report bytes");
        expect(document?.fields.caption).toContain("Waiting for delegated work.");
      } else {
        expect([...visibleMarkup.values()]).toEqual([
          { inline_keyboard: [[{ text: "Continue", callback_data: "go" }]] },
        ]);
      }
    },
  );

  it("shows compaction transitions and retires progress only after the final is accepted", async () => {
    const snapshots: string[] = [];
    let progressId: number | undefined;
    await dispatchProgressTurn(
      async (options) => {
        await options?.onItemEvent?.({
          kind: "preamble",
          itemId: "compaction",
          phase: "update",
          progressText: "Incomplete preamble",
        });
        await vi.advanceTimersByTimeAsync(1_500);
        expect([...visibleMessages.values()]).toEqual([]);
        await options?.onItemEvent?.({
          kind: "preamble",
          itemId: "compaction",
          phase: "end",
          progressText: "Checking the retained context.",
        });
        await options?.onPlanUpdate?.({
          phase: "update",
          steps: [{ step: "Retain the current goal", status: "in_progress" }],
        });
        await options?.onCompactionStart?.();
        await waitForBotApiCall((call) => String(call.fields.text).includes("Compacting context"));
        progressId = [...visibleMessages.keys()][0];
        snapshots.push(visibleMessages.get(progressId!)!);
        expect(visibleMessages.get(progressId!)).toContain("Checking the retained context.");
        expect(visibleMessages.get(progressId!)).toContain("Retain the current goal");
        await options?.onItemEvent?.({
          kind: "preamble",
          itemId: "compaction",
          phase: "start",
          progressText: "",
        });
        await options?.onCompactionEnd?.({ completed: false });
        await waitForBotApiCall((call) =>
          String(call.fields.text).includes("Compaction incomplete"),
        );
        snapshots.push(visibleMessages.get(progressId!)!);
        expect(visibleMessages.get(progressId!)).not.toContain("Checking the retained context.");
        expect(visibleMessages.get(progressId!)).toContain("Retain the current goal");
        await options?.onCompactionStart?.();
        await options?.onCompactionEnd?.({ completed: true });
        await waitForBotApiCall((call) => String(call.fields.text).includes("Compaction complete"));
        snapshots.push(visibleMessages.get(progressId!)!);
      },
      { mode: "progress", toolProgress: true, finalReply: { text: "Compaction finished." } },
    );
    expect(snapshots).toEqual([
      expect.stringContaining("Compacting context"),
      expect.stringContaining("Compaction incomplete"),
      expect.stringContaining("Compaction complete"),
    ]);
    expect([...visibleMessages.values()]).toEqual(["Compaction finished."]);
    expect(JSON.stringify(acceptedCalls)).not.toContain("Incomplete preamble");
    const finalAt = acceptedCalls.findIndex(
      (call) => call.method === "sendMessage" && call.fields.text === "Compaction finished.",
    );
    const retiredAt = acceptedCalls.findIndex(
      (call) => call.method === "deleteMessage" && Number(call.fields.message_id) === progressId,
    );
    expect(finalAt).toBeGreaterThanOrEqual(0);
    expect(retiredAt).toBeGreaterThan(finalAt);
  });

  it("suppresses typed reasoning while preserving literal answer text when reasoning is off", async () => {
    await dispatchProgressTurn(
      async (options) => {
        await options?.onBlockReply?.({ text: "< / internal", isReasoning: true });
        await vi.advanceTimersByTimeAsync(1_500);
        expect([...visibleMessages.values()]).toEqual([]);
        await options?.onReasoningStream?.({
          text: "<think>Checking independent evidence before answering.</think>",
          isReasoningSnapshot: true,
        });
      },
      {
        mode: "partial",
        toolProgress: true,
        cfg: { agents: { defaults: { reasoningDefault: "off" } } },
        finalReply: [
          { text: "A durable conclusion from the evidence.", isReasoning: true },
          { text: "Before <think>literal tag text after" },
        ],
      },
    );
    expect([...visibleMessages.values()]).toEqual(["Before &lt;think&gt;literal tag text after"]);
    expect(JSON.stringify(acceptedCalls)).not.toContain("internal");
    expect(JSON.stringify(acceptedCalls)).not.toContain("A durable conclusion");
  });

  it.each(["raw", "prepared"] as const)(
    "preserves the %s directive contract through the physical audio sender",
    async (source) => {
      const sender = source === "raw" ? deliverReplies : deliverStructuredReplies;
      const delivered = await sender({
        replies: [
          {
            text: "[[reply_to:999]] [[audio_as_voice]] Example",
            mediaUrl: "https://example.test/note.ogg",
          },
        ],
        bot: http.bot,
        chatId: "123",
        token: http.token,
        runtime: createNonExitingRuntime(),
        replyToMode: "off",
        textLimit: 4096,
        thread: { id: 777, scope: "dm" },
        mediaLoader: async () => ({
          buffer: Buffer.from("independent audio bytes"),
          contentType: "audio/ogg",
          kind: "audio",
          fileName: "note.ogg",
        }),
      });
      expect(delivered.delivered).toBe(true);
      const media = acceptedCalls.filter(
        (call) => call.method === "sendAudio" || call.method === "sendVoice",
      );
      expect(media).toHaveLength(1);
      const [call] = media;
      assert(call, "Expected an accepted Telegram audio upload");
      expect(call.method).toBe(source === "raw" ? "sendVoice" : "sendAudio");
      expect(call.fields.message_thread_id).toBe("777");
      expect(call.fields.caption).toBe(
        source === "raw" ? "Example" : "[[reply_to:999]] [[audio_as_voice]] Example",
      );
      expect(call.fields.reply_to_message_id).toBe(source === "raw" ? "999" : undefined);
      expect(call.fields.reply_parameters).toBeUndefined();
      expect(
        await resolveTelegramTestUpload(call.fields, source === "raw" ? "voice" : "audio").text(),
      ).toBe("independent audio bytes");
      expect([...visibleMessages.values()]).toEqual([
        source === "raw" ? "Example" : "[[reply_to:999]] [[audio_as_voice]] Example",
      ]);
    },
  );

  it("records a rejected final without claiming the rejected delivery warning was visible", async () => {
    http.respondToCall = (call) =>
      call.method === "sendMessage" &&
      (call.fields.text === "fail" || DELIVERY_WARNING.includes(String(call.fields.text)))
        ? { error_code: 400, description: "Bad Request: fixture delivery rejected" }
        : undefined;
    await dispatchProgressTurn(async () => undefined, {
      mode: "off",
      toolProgress: true,
      textLimit: 80,
      producer: async ({ dispatcher }) => {
        dispatcher.sendFinalReply({ text: "fail" });
        const counts = dispatcher.getQueuedCounts();
        return { queuedFinal: counts.final > 0, counts };
      },
      allowErrors: true,
    });
    expect(calls.some((call) => call.method === "sendMessage" && call.fields.text === "fail")).toBe(
      true,
    );
    expect(
      calls.filter(
        (call) =>
          call.method === "sendMessage" &&
          String(call.fields.text).startsWith(DELIVERY_WARNING_PREFIX),
      ),
    ).toHaveLength(1);
    expect([...visibleMessages.values()]).toEqual([]);
  });
});
