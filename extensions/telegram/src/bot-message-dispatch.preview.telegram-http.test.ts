import type { PluginHookReplyPayloadSendingEvent } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  addTestHook,
  createEmptyPluginRegistry,
  initializeGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { describe, expect, it, vi } from "vitest";
import { createTelegramDispatchHttpFixture } from "./bot-message-dispatch.telegram-http.test-support.js";

describe("Telegram preview and presentation delivery through HTTP", () => {
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

  it.each([
    { hook: "reply_payload_sending", mode: "partial" },
    { hook: "message_sending", mode: "progress" },
  ] as const)("gates real preview writes with $hook in $mode mode", async ({ hook, mode }) => {
    const registry = createEmptyPluginRegistry();
    const modifierEntered = createDeferred<void>();
    const releaseModifier = createDeferred<void>();
    if (hook === "reply_payload_sending") {
      addTestHook({
        registry,
        pluginId: "http-preview-policy",
        hookName: hook,
        handler: async (event: PluginHookReplyPayloadSendingEvent) => {
          modifierEntered.resolve();
          await releaseModifier.promise;
          return { payload: { ...event.payload, text: "Allowed final" } };
        },
      });
    } else if (hook === "message_sending") {
      addTestHook({
        registry,
        pluginId: "http-preview-policy",
        hookName: hook,
        handler: async () => {
          modifierEntered.resolve();
          await releaseModifier.promise;
          return { content: "Allowed final" };
        },
      });
    }
    initializeGlobalHookRunner(registry);
    const dispatched = dispatchProgressTurn(
      async (options) => {
        await options?.onPartialReply?.({
          text: "Pre-hook answer containing fixture-secret-answer",
        });
        await emitToolStart(options, {
          name: "exec",
          phase: "start",
          toolCallId: "private-tool",
          args: { command: "echo fixture-secret-command" },
        });
        await options?.onReasoningStream?.({
          text: "<think>Independent reasoning containing fixture-secret-reasoning</think>",
        });
      },
      {
        mode,
        toolProgress: true,
        cfg: { agents: { defaults: { reasoningDefault: "stream" } } },
        finalReply: { text: "Pre-hook final containing fixture-secret-final" },
      },
    );
    try {
      await Promise.race([
        modifierEntered.promise,
        dispatched.then(() => {
          throw new Error("dispatch completed without entering the modifying hook");
        }),
      ]);
      expect(calls.filter((call) => call.method !== "sendChatAction")).toEqual([]);
    } finally {
      releaseModifier.resolve();
      await dispatched;
    }
    const writes = JSON.stringify(calls);
    expect(writes).not.toContain("fixture-secret");
    expect([...visibleMessages.values()]).toEqual(["Allowed final"]);
  });

  it.each(["partial", "block"] as const)(
    "paginates quoted %s finals without losing text or replacing the accepted preview",
    async (mode) => {
      const context = http.createContext();
      const finalText =
        mode === "block"
          ? "A".repeat(600) + "B".repeat(600) + "C".repeat(600)
          : "A".repeat(4096) + "B".repeat(500);
      let preview: Array<[number, string]> = [];
      await dispatchProgressTurn(
        async (options) => {
          await options?.onPartialReply?.({ text: finalText });
          await waitForBotApiCall((call) => call.method === "sendMessage");
          preview = [...visibleMessages];
        },
        {
          mode,
          context,
          replyToMode: "all",
          toolProgress: false,
          cfg: { agents: { defaults: { blockStreamingDefault: "on" } } },
          telegramCfg: {
            streaming: {
              mode,
              preview: { toolProgress: false, chunk: { minChars: 100, maxChars: 600 } },
            },
          },
          finalReply: { text: finalText, replyToCurrent: true },
        },
      );
      const pages = [...visibleMessages];
      const sends = acceptedCalls.filter((call) => call.method === "sendMessage");
      expect(sends[0]?.fields.reply_parameters).toMatchObject({
        message_id: context.msg.message_id,
        quote: "Run the failing command.",
        quote_position: 0,
      });
      for (const call of sends) {
        if (call.fields.reply_to_message_id !== undefined) {
          expect(call.fields.reply_to_message_id).toBe(context.msg.message_id);
        } else {
          expect(call.fields.reply_parameters).toMatchObject({
            message_id: context.msg.message_id,
          });
        }
      }
      expect(preview).toHaveLength(1);
      expect(pages[0]?.[0]).toBe(preview[0]?.[0]);
      expect(pages.map(([, text]) => text).join("")).toBe(finalText);
      for (const [, text] of pages) {
        expect(text.length).toBeLessThanOrEqual(mode === "block" ? 600 : 4096);
      }
      if (mode === "block") {
        expect(pages.map(([, text]) => text)).toEqual([
          "A".repeat(600),
          "B".repeat(600),
          "C".repeat(600),
        ]);
      }
    },
  );

  it("keeps sending typing before Telegram expiry beyond the default pipeline cutoff", async () => {
    const acceptedTypingAt: number[] = [];
    http.respondToCall = (call) => {
      if (call.method === "sendChatAction" && call.fields.action === "typing") {
        acceptedTypingAt.push(Date.now());
      }
      return undefined;
    };
    await dispatchProgressTurn(
      async () => {
        await waitForBotApiCall((call) => call.method === "sendChatAction");
        await http.waitForTypingSend();
        await vi.advanceTimersByTimeAsync(0);
        for (let interval = 0; interval < 17; interval += 1) {
          const previousCount = acceptedTypingAt.length;
          await vi.advanceTimersByTimeAsync(4_000);
          await http.waitForTypingSend();
          expect(acceptedTypingAt.length).toBeGreaterThan(previousCount);
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(acceptedTypingAt.at(-1)! - acceptedTypingAt[0]!).toBeGreaterThan(60_000);
        for (let index = 1; index < acceptedTypingAt.length; index += 1) {
          expect(acceptedTypingAt[index]! - acceptedTypingAt[index - 1]!).toBeLessThan(5_000);
        }
        // SQLite workers use wall time, not this test's simulated typing clock.
        vi.setSystemTime(vi.getRealSystemTime());
      },
      { mode: "off", toolProgress: false, finalReply: { text: "Long-running work complete." } },
    );
    const settledTypingCount = acceptedTypingAt.length;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(acceptedTypingAt).toHaveLength(settledTypingCount);
  });

  it.each(["control-only", "immediate", "buffered"] as const)(
    "delivers presentation controls through the %s crossing",
    async (branch) => {
      const controls: ReplyPayload = {
        presentation: {
          blocks: [
            ...(branch === "control-only"
              ? []
              : [
                  {
                    type: "chart" as const,
                    chartType: "pie" as const,
                    title: "Revenue mix",
                    segments: [
                      { label: "Product", value: 60 },
                      { label: "Services", value: 40 },
                    ],
                  },
                  {
                    type: "table" as const,
                    caption: "Pipeline",
                    headers: ["Account", "Stage"],
                    rows: [["Acme", "Won"]],
                  },
                ]),
            {
              type: "buttons",
              buttons: [
                { label: "Retry", value: "retry" },
                { label: "Launch", action: { type: "web-app", url: "https://example.com/app" } },
                { label: "Copy manually", value: "x".repeat(65) },
              ],
            },
          ],
        },
      };
      if (branch === "buffered") {
        http.respondToCall = (call) =>
          String(call.fields.text).includes("first reasoning attempt")
            ? { error_code: 400, description: "Bad Request: reasoning rejected" }
            : undefined;
      }
      await dispatchProgressTurn(
        async (options) => {
          if (branch === "immediate") {
            await options?.onPartialReply?.({
              text: "The presentation is ready for review and interactive selection.",
            });
            await waitForBotApiCall((call) => call.method === "sendMessage");
            await options?.onBlockReply?.(controls);
            await waitForBotApiCall(
              (call) => call.method === "editMessageText" && call.fields.reply_markup !== undefined,
            );
            expect(visibleMarkup.get(1)).toMatchObject({
              inline_keyboard: expect.arrayContaining([
                expect.arrayContaining([{ text: "Retry", callback_data: "retry" }]),
              ]),
            });
          } else if (branch === "buffered") {
            await options?.onBlockReply?.({
              text: "<think>first reasoning attempt</think>",
              isReasoning: true,
            });
            await waitForBotApiCall((call) =>
              String(call.fields.text).includes("first reasoning attempt"),
            );
          }
        },
        {
          mode: branch === "control-only" ? "off" : "partial",
          toolProgress: false,
          cfg: {
            agents: { defaults: { reasoningDefault: branch === "buffered" ? "stream" : "off" } },
          },
          finalReply:
            branch === "buffered"
              ? [
                  controls,
                  { text: "<think>accepted second reasoning attempt</think>", isReasoning: true },
                ]
              : controls,
          allowErrors: branch === "buffered",
        },
      );
      const answer = [...visibleMessages].find(([id]) => visibleMarkup.has(id));
      expect(answer).toBeDefined();
      expect(answer?.[1]).toContain("Copy manually");
      expect(JSON.stringify(visibleMarkup.get(answer![0]))).toContain('"callback_data":"retry"');
      expect(JSON.stringify(visibleMarkup.get(answer![0]))).toContain(
        '"web_app":{"url":"https://example.com/app"}',
      );
      expect(JSON.stringify(visibleMarkup.get(answer![0]))).not.toContain("x".repeat(65));
      if (branch !== "control-only") {
        expect(answer?.[1]).toContain("Revenue mix");
        expect(answer?.[1]).toContain("Product");
        expect(answer?.[1]).toContain("Acme");
        expect(answer?.[1]).toContain("Won");
      }
      if (branch === "buffered") {
        const sends = acceptedCalls.filter((call) => call.method === "sendMessage");
        expect(String(sends[0]?.fields.text)).toContain("accepted second reasoning attempt");
        expect(String(sends.at(-1)?.fields.text)).toContain("Revenue mix");
      } else if (branch === "immediate") {
        expect([...visibleMessages.keys()]).toEqual([1]);
      }
    },
  );

  it("retires unaccepted pre-tool text across a tool-only assistant message", async () => {
    const preamble = "I will inspect the files before answering.";
    const finalText = "The requested result.";
    await dispatchProgressTurn(
      async (options) => {
        await options?.onPartialReply?.({ text: preamble, delta: preamble });
        await waitForBotApiCall(
          (call) => call.method === "sendMessage" && call.fields.text === preamble,
        );
        await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "first" });
        await waitForBotApiCall(
          (call) => call.method === "sendMessage" && String(call.fields.text).includes("🛠️ Exec"),
        );
        // An unphased provider can continue with a tool-only assistant message.
        // Its start clears progress suppression without replacing the old preview.
        await options?.onAssistantMessageStart?.();
        await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "second" });
        await options?.onAssistantMessageStart?.();
      },
      { mode: "partial", toolProgress: true, finalReply: { text: finalText } },
    );

    // Retired previews keep their existing four-second minimum display time.
    await expect.poll(() => [...visibleMessages.values()], { timeout: 5_000 }).toEqual([finalText]);
  });

  it("does not prefix a terminal error with pre-tool text when tool progress is off", async () => {
    const toolProgress = false;
    const preamble = "I will inspect the files before answering.";
    const finalText = "The provider failed. Please try again.";
    await dispatchProgressTurn(
      async (options) => {
        await options?.onPartialReply?.({ text: preamble, delta: preamble });
        await waitForBotApiCall(
          (call) => call.method === "sendMessage" && call.fields.text === preamble,
        );
        await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "first" });
      },
      { mode: "partial", toolProgress, finalReply: { text: finalText, isError: true } },
    );

    await expect.poll(() => [...visibleMessages.values()], { timeout: 5_000 }).toEqual([finalText]);
  });

  it("retires a lazy partial queued immediately before a quiet tool start", async () => {
    const preamble = "I will inspect the files before answering.";
    const finalText = "The provider failed. Please try again.";
    await dispatchProgressTurn(
      async (options) => {
        // Core preserves callback start order, not completion order. The partial
        // is still queued when the tool callback starts and must retire first.
        const partial = options?.onPartialReply?.({ text: preamble, delta: preamble });
        const tool = emitToolStart(options, { name: "exec", phase: "start", toolCallId: "first" });
        await Promise.all([partial, tool]);
      },
      { mode: "partial", toolProgress: false, finalReply: { text: finalText, isError: true } },
    );
    await expect.poll(() => [...visibleMessages.values()], { timeout: 5_000 }).toEqual([finalText]);
  });

  it("preserves an interrupted answer when an existing tool only updates", async () => {
    const answer = "The first result is ready, and the remaining work is still running.";
    const failure = "The provider failed. Please try again.";
    await dispatchProgressTurn(
      async (options) => {
        await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "first" });
        await options?.onAssistantMessageStart?.();
        await options?.onPartialReply?.({ text: answer, delta: answer });
        await waitForBotApiCall(
          (call) => call.method === "sendMessage" && call.fields.text === answer,
        );
        await emitToolStart(options, { name: "exec", phase: "update", toolCallId: "first" });
      },
      { mode: "partial", toolProgress: false, finalReply: { text: failure, isError: true } },
    );
    expect([...visibleMessages.values()]).toEqual([`${answer}\n\n${failure}`]);
  });
  it("keeps an accepted preview when another final follows", async () => {
    const mode = "partial";
    const answer = "A complete answer that is long enough to preview.";
    let previewId: number | undefined;
    await dispatchProgressTurn(
      async (options) => {
        await options?.onPartialReply?.({ text: answer });
        await waitForBotApiCall(
          (call) => call.method === "sendMessage" && call.fields.text === answer,
        );
        previewId = [...visibleMessages.keys()][0];
      },
      {
        mode,
        toolProgress: false,
        finalReply: [{ text: answer }, { text: "A separate final status." }],
      },
    );
    expect([...visibleMessages.values()]).toEqual([answer, "A separate final status."]);
    expect([...visibleMessages.keys()][0]).toBe(previewId);
  });

  it("materializes a block-only terminal answer in partial mode", async () => {
    const mode = "partial";
    await dispatchProgressTurn(
      async (options) => {
        await options?.onBlockReply?.({ text: "Block-only terminal answer." });
      },
      { mode, toolProgress: false, finalReply: [] },
    );
    expect([...visibleMessages.values()]).toEqual(["Block-only terminal answer."]);
  });

  it("preserves distinct indexed assistant blocks as separate preview messages", async () => {
    const first = setReplyPayloadMetadata(
      { text: "The first assistant answer reports the findings from site A." },
      { assistantMessageIndex: 0 },
    );
    const second = setReplyPayloadMetadata(
      { text: "The second assistant answer reports different findings from site B." },
      { assistantMessageIndex: 1 },
    );
    let firstPreviewId: number | undefined;
    await dispatchProgressTurn(async () => undefined, {
      mode: "partial",
      toolProgress: false,
      producer: async ({ dispatcher, replyOptions }) => {
        await replyOptions?.onBlockReplyQueued?.(first, { assistantMessageIndex: 0 });
        await replyOptions?.onBlockReplyQueued?.(second, { assistantMessageIndex: 1 });
        dispatcher.sendBlockReply(first);
        await waitForBotApiCall(
          (call) => call.method === "sendMessage" && call.fields.text === first.text,
        );
        firstPreviewId = [...visibleMessages.keys()][0];
        dispatcher.sendBlockReply(second);
        dispatcher.sendFinalReply(second);
        const counts = dispatcher.getQueuedCounts();
        return { queuedFinal: counts.final > 0, counts };
      },
    });
    expect([...visibleMessages.values()]).toEqual([first.text, second.text]);
    expect(visibleMessages.get(firstPreviewId!)).toBe(first.text);
    expect(
      acceptedCalls.filter((call) => call.method === "sendMessage").map((call) => call.fields.text),
    ).toEqual([first.text, second.text]);
  });

  it("retires a skipped indexed block preview before the next assistant answer", async () => {
    const discarded = "An unaccepted preview from the assistant that chose not to reply.";
    const answer = "The next assistant supplies the answer that must remain visible.";
    const skipped = setReplyPayloadMetadata({ text: "NO_REPLY" }, { assistantMessageIndex: 0 });
    let discardedPreviewId: number | undefined;
    await dispatchProgressTurn(async () => undefined, {
      mode: "partial",
      toolProgress: false,
      producer: async ({ dispatcher, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: discarded });
        await waitForBotApiCall(
          (call) => call.method === "sendMessage" && call.fields.text === discarded,
        );
        discardedPreviewId = [...visibleMessages.keys()][0];
        await replyOptions?.onBlockReplyQueued?.(skipped, { assistantMessageIndex: 0 });
        await replyOptions?.onAssistantMessageStart?.();
        dispatcher.sendBlockReply(skipped);
        await replyOptions?.onPartialReply?.({ text: answer });
        dispatcher.sendFinalReply({ text: answer });
        const counts = dispatcher.getQueuedCounts();
        return { queuedFinal: counts.final > 0, counts };
      },
    });
    expect([...visibleMessages.values()]).toEqual([answer]);
    expect(visibleMessages.has(discardedPreviewId!)).toBe(false);
    expect(
      acceptedCalls
        .filter((call) => call.method === "deleteMessage")
        .map((call) => Number(call.fields.message_id)),
    ).toEqual([discardedPreviewId]);
    expect(
      acceptedCalls.filter((call) => call.method === "sendMessage").map((call) => call.fields.text),
    ).toEqual([discarded, answer]);
  });

  it("preserves an accepted partial answer when the model fails", async () => {
    const partial = "An accepted partial answer before the model failed.";
    let reachedModel = false;
    let visibleBeforeFailure: string[] | undefined;
    await dispatchProgressTurn(
      async (options) => {
        reachedModel = true;
        await options?.onPartialReply?.({ text: partial });
        await waitForBotApiCall(
          (call) => call.method === "sendMessage" && call.fields.text === partial,
        );
        visibleBeforeFailure = [...visibleMessages.values()];
        options?.onAgentRunTerminalOutcome?.("failed");
        throw new Error("private-provider-failure");
      },
      { mode: "partial", toolProgress: false },
    );
    expect(reachedModel).toBe(true);
    expect(visibleBeforeFailure).toEqual([partial]);
    const visible = [...visibleMessages.values()];
    expect(visible, JSON.stringify({ calls, acceptedCalls })).toHaveLength(1);
    expect(visible[0]).toContain("Please try again");
    expect(visible[0]).toContain(partial);
    expect(JSON.stringify(calls)).not.toContain("private-provider-failure");
  });

  it.each([false, true])(
    "keeps replay failure custody with a terminal provider failure=%s",
    async (terminalFailure) => {
      const context = http.createContext();
      const chat = { id: -1001234, type: "supergroup" as const, title: "Replay room" };
      context.chatId = chat.id;
      context.isGroup = true;
      context.msg.chat = chat;
      context.primaryCtx.message.chat = chat;
      context.route.sessionKey = "agent:default:telegram:group:-1001234";
      Object.assign(context.ctxPayload, {
        ChatType: "group",
        From: "telegram:group:-1001234",
        To: "telegram:-1001234",
        SessionKey: context.route.sessionKey,
        WasMentioned: true,
      });
      await dispatchProgressTurn(
        async (options) => {
          if (terminalFailure) {
            options?.onAgentRunTerminalOutcome?.("failed");
          }
          throw new Error("private-provider-http-500");
        },
        {
          context,
          mode: "off",
          toolProgress: false,
          cfg: { messages: { groupChat: { visibleReplies: "message_tool" } } },
          telegramCfg: { silentErrorReplies: true },
          suppressFailureFallback: true,
          allowErrors: true,
          outcome: terminalFailure ? "completed" : "failed-retryable",
        },
      );
      const replies = acceptedCalls.filter((call) => call.method === "sendMessage");
      expect(replies).toHaveLength(terminalFailure ? 1 : 0);
      if (terminalFailure) {
        expect(replies[0]?.fields.text).toContain("Please try again.");
        expect(replies[0]?.fields.disable_notification).toBe(true);
      }
      expect(JSON.stringify(calls)).not.toContain("private-provider-http-500");
    },
  );
});
