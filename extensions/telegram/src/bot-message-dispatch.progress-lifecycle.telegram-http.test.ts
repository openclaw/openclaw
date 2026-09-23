import type { PluginHookReplyPayloadSendingEvent } from "openclaw/plugin-sdk/core";
import {
  addTestHook,
  createEmptyPluginRegistry,
  initializeGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { createNonExitingRuntime } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import type { ReplyResolverOptions } from "./bot-message-dispatch.telegram-http.test-support.js";
import { createTelegramDispatchHttpFixture } from "./bot-message-dispatch.telegram-http.test-support.js";
import { deliverReplies, deliverStructuredReplies } from "./bot/delivery.replies.js";
import * as sendRuntime from "./send.runtime.js";
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

  it.each(["media", "buttons"] as const)(
    "delivers continuation %s instead of swallowing it in card adoption",
    async (content) => {
      let adopted = false;
      if (content === "media") {
        vi.spyOn(sendRuntime, "loadWebMedia").mockResolvedValue({
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

  it.each([
    { name: "cancelled final", before: undefined, finals: ["cancel"], fallback: false },
    { name: "empty final after hook", before: undefined, finals: ["empty-hook"], fallback: false },
    {
      name: "cancelled tool then failed final",
      before: "cancel-tool",
      finals: ["fail"],
      fallback: true,
    },
    {
      name: "cancelled block then failed final",
      before: "cancel-block",
      finals: ["fail"],
      fallback: true,
    },
    {
      name: "failed final then cancelled final",
      before: undefined,
      finals: ["fail", "cancel"],
      fallback: true,
    },
    {
      name: "failed tool then cancelled final",
      before: "fail-tool",
      finals: ["cancel"],
      fallback: false,
    },
    { name: "partially delivered final", before: undefined, finals: ["partial"], fallback: true },
    {
      name: "failed final and fallback",
      before: undefined,
      finals: ["fail"],
      fallback: true,
      rejectFallback: true,
    },
  ] as const)(
    "settles real hook and transport outcomes for $name",
    async ({ before, finals, fallback, ...scenario }) => {
      const registry = createEmptyPluginRegistry();
      const hookDeliveries: Array<{ kind: string; text: string | undefined }> = [];
      addTestHook({
        registry,
        pluginId: "http-outcome-policy",
        hookName: "reply_payload_sending",
        handler: (event: PluginHookReplyPayloadSendingEvent) => {
          hookDeliveries.push({ kind: event.kind, text: event.payload.text });
          if (event.payload.text?.startsWith("cancel")) {
            return { cancel: true };
          }
          if (event.payload.text === "empty-hook") {
            return { payload: { ...event.payload, text: "" } };
          }
          return undefined;
        },
      });
      initializeGlobalHookRunner(registry);
      const rejectFallback = "rejectFallback" in scenario && scenario.rejectFallback;
      http.respondToCall = (call) =>
        call.method === "sendMessage" &&
        (String(call.fields.text).startsWith("fail") ||
          call.fields.text === "B".repeat(40) ||
          (rejectFallback && DELIVERY_WARNING.includes(String(call.fields.text))))
          ? { error_code: 400, description: "Bad Request: fixture delivery rejected" }
          : undefined;
      await dispatchProgressTurn(async () => undefined, {
        mode: "off",
        toolProgress: true,
        textLimit: 80,
        producer: async ({ dispatcher }) => {
          if (before?.endsWith("tool")) {
            dispatcher.sendToolResult({ text: before });
          } else if (before) {
            dispatcher.sendBlockReply({ text: before });
          }
          for (const text of finals) {
            dispatcher.sendFinalReply({
              text: text === "partial" ? "A".repeat(80) + "B".repeat(40) : text,
            });
          }
          const counts = dispatcher.getQueuedCounts();
          return { queuedFinal: counts.final > 0, counts };
        },
        allowErrors: true,
      });
      if (before) {
        expect(hookDeliveries).toContainEqual({
          kind: before.endsWith("tool") ? "tool" : "block",
          text: before,
        });
      }
      if (finals.some((text) => text === "fail")) {
        expect(
          calls.some((call) => call.method === "sendMessage" && call.fields.text === "fail"),
        ).toBe(true);
      }
      const fallbackSends = calls.filter(
        (call) =>
          call.method === "sendMessage" &&
          String(call.fields.text).startsWith(DELIVERY_WARNING_PREFIX),
      );
      expect(fallbackSends).toHaveLength(fallback ? 1 : 0);
      expect(JSON.stringify(acceptedCalls)).not.toContain("cancel");
      const visible = [...visibleMessages.values()];
      const accepted = finals.some((text) => text === "partial") ? ["A".repeat(80)] : [];
      expect(visible.slice(0, accepted.length)).toEqual(accepted);
      expect(visible.slice(accepted.length).join("")).toBe(
        fallback && !rejectFallback ? DELIVERY_WARNING : "",
      );
    },
  );

  it.each([false, true])(
    "preserves the post-progress final when Telegram rejects cleanup (error: %s)",
    async (isError) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
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
          finalReply: { text: "A".repeat(80) + "B".repeat(40), isError },
        },
      );
      await vi.advanceTimersByTimeAsync(4_100);
      await waitForBotApiCall((call) => call.method === "deleteMessage");
      expect([...visibleMessages.values()].slice(1)).toEqual(["A".repeat(80), "B".repeat(40)]);
      expect(
        calls.filter((call) => call.fields.text === "No response generated. Please try again."),
      ).toEqual([]);
    },
  );

  it("flushes a pending parent progress surface before adopting a fast yield", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const commentary = "The delegated check is still running.";
    let receipt: unknown;
    const waitingPayload = setReplyPayloadMetadata(
      { text: "Waiting for delegated work." },
      {
        progressContinuation: {
          adopt: async (candidate) => {
            receipt = candidate;
            return true;
          },
          close: () => undefined,
        },
      },
    );
    await dispatchProgressTurn(
      async (options) => {
        await options?.onItemEvent?.({
          kind: "preamble",
          itemId: "parent-commentary",
          phase: "end",
          progressText: commentary,
        });
        expect(calls.filter((call) => call.method === "sendMessage")).toEqual([]);
      },
      { mode: "progress", toolProgress: true, finalReply: waitingPayload },
    );

    expect(receipt).toMatchObject({
      messageId: String([...visibleMessages.keys()][0]),
      text: expect.stringContaining(commentary),
      snapshot: { statusHeadline: commentary },
    });
    expect([...visibleMessages.values()]).toEqual([expect.stringContaining(commentary)]);
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
    expect(calls.some((call) => call.fields.text === waitingPayload.text)).toBe(false);
  });

  it.each([true, false])(
    "retains the existing progress card only when continuation custody is accepted (%s)",
    async (accept) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
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

  it.each([false, true])(
    "keeps tool progress until the final answer replaces it (assistant boundary: %s)",
    async (assistantBoundary) => {
      const finalText = "The requested result.";
      let progressMessageId: number | undefined;
      await dispatchProgressTurn(
        async (options) => {
          await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "first" });
          await waitForBotApiCall(
            (call) => call.method === "sendMessage" && String(call.fields.text).includes("Exec"),
          );
          progressMessageId = [...visibleMessages.keys()][0];
          await options?.onItemEvent?.({
            kind: "search",
            itemId: "search-docs",
            phase: "update",
            progressText: "Inspecting the release notes",
          });
          await waitForBotApiCall((call) =>
            String(call.fields.text).includes("Inspecting the release notes"),
          );
          if (assistantBoundary) {
            await options?.onAssistantMessageStart?.();
          }
          expect([...visibleMessages.values()]).toEqual([expect.stringContaining("Exec")]);
          expect([...visibleMessages.values()][0]).toContain("Inspecting the release notes");
          expect(calls.some((call) => call.method === "deleteMessage")).toBe(false);
        },
        { mode: "partial", toolProgress: true, finalReply: { text: finalText } },
      );

      await expect
        .poll(() => [...visibleMessages.values()], { timeout: 5_000 })
        .toEqual([finalText]);
      const finalMessageId = [...visibleMessages.keys()][0];
      expect(finalMessageId).not.toBe(progressMessageId);
      expect(
        calls.filter((call) => call.method === "sendMessage" && call.fields.text === finalText),
      ).toHaveLength(1);
      expect(
        calls
          .filter((call) => call.method === "deleteMessage")
          .map((call) => Number(call.fields.message_id)),
      ).toEqual([progressMessageId]);
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
});
