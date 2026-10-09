import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
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

describe("Telegram preview, presentation, and progress delivery through HTTP", () => {
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

  it("keeps the same preview after one HTTP 502 edit failure", async () => {
    const initial = "The initial answer is visible while the remaining work completes.";
    const updated = `${initial} More details are ready.`;
    const finalText = `${updated} The answer is complete.`;
    let rejected = false;
    http.respondToCall = (call) => {
      if (call.method === "editMessageText" && !rejected) {
        rejected = true;
        return { error_code: 502, description: "Bad Gateway" };
      }
      return undefined;
    };
    await dispatchProgressTurn(
      async (options) => {
        await options?.onPartialReply?.({ text: initial });
        await waitForBotApiCall((call) => call.method === "sendMessage");
        await options?.onPartialReply?.({ text: updated });
        await waitForBotApiCall((call) => call.method === "editMessageText");
      },
      { mode: "partial", toolProgress: false, finalReply: { text: finalText } },
    );
    expect(rejected).toBe(true);
    expect(acceptedCalls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
    expect([...visibleMessages]).toEqual([[1, finalText]]);
  });

  it("delivers hooked progress before final with message_sending in progress mode", async () => {
    const mode = "progress";
    const registry = createEmptyPluginRegistry();
    addTestHook({
      registry,
      pluginId: "http-progress-policy",
      hookName: "message_sending",
      handler: (event: { content: string }) => ({
        content: event.content.replace("fixture-secret", "filtered"),
      }),
    });
    initializeGlobalHookRunner(registry);
    await dispatchProgressTurn(
      async (options, channelOptions) => {
        // This is the channel override consumed by the reply runner, whose
        // default otherwise disables completed-block delivery.
        expect(channelOptions?.disableBlockStreaming).toBe(false);
        await options?.onPartialReply?.({ text: "Unapproved partial fixture-secret" });
        expect(visibleMessages.size).toBe(0);
        await options?.onBlockReply?.({ text: "Checking fixture-secret while work continues." });
        await waitForBotApiCall(
          (call) => call.fields.text === "Checking filtered while work continues.",
        );
        expect([...visibleMessages.values()]).toEqual(["Checking filtered while work continues."]);
      },
      { mode, toolProgress: false, finalReply: { text: "Finished fixture-secret." } },
    );
    expect([...visibleMessages.values()]).toEqual([
      "Checking filtered while work continues.",
      "Finished filtered.",
    ]);
    expect(JSON.stringify(calls)).not.toContain("fixture-secret");
    expect(calls.some((call) => call.method === "editMessageText")).toBe(false);
    await dispatchProgressTurn(
      async (_options, channelOptions) => {
        expect(channelOptions?.disableBlockStreaming).toBe(true);
      },
      {
        mode,
        toolProgress: false,
        telegramCfg: {
          streaming: { mode, block: { enabled: false } },
        },
        finalReply: { text: "Opted-out final fixture-secret." },
      },
    );
    expect([...visibleMessages.values()]).toEqual([
      "Checking filtered while work continues.",
      "Finished filtered.",
      "Opted-out final filtered.",
    ]);
    await dispatchProgressTurn(
      async (_options, channelOptions) => {
        expect(channelOptions?.disableBlockStreaming).toBe(true);
      },
      {
        mode,
        toolProgress: false,
        cfg: { agents: { defaults: { blockStreamingDefault: "off" } } },
        finalReply: { text: "Global-off final fixture-secret." },
      },
    );
    expect([...visibleMessages.values()]).toEqual([
      "Checking filtered while work continues.",
      "Finished filtered.",
      "Opted-out final filtered.",
      "Global-off final filtered.",
    ]);
  });

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

  it("paginates quoted block finals without losing text or replacing the accepted preview", async () => {
    const mode = "block";
    const context = http.createContext();
    const finalText = "A".repeat(600) + "B".repeat(600) + "C".repeat(600);
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
      expect(text.length).toBeLessThanOrEqual(600);
    }
    expect(pages.map(([, text]) => text)).toEqual([
      "A".repeat(600),
      "B".repeat(600),
      "C".repeat(600),
    ]);
  });

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
  it("preserves structured command detail against summaries with status privacy", async () => {
    await dispatchProgressTurn(
      async (options, channelOptions) => {
        await emitToolStart(options, {
          name: "exec",
          phase: "start",
          toolCallId: "exec-1",
          args: { command: "echo fixture-private-token" },
        });
        await waitForBotApiCall(
          (call) => call.method === "sendMessage" && String(call.fields.text).includes("Exec"),
        );
        expect(
          await channelOptions?.onToolResult?.({
            text: "Formatted summary must not replace the command",
            channelData: { openclawToolProgressId: "tool:exec-1" },
          }),
        ).toBe(true);
        await options?.onCommandOutput?.({
          phase: "end",
          title: "command echo fixture-private-token",
          name: "exec",
          toolCallId: "exec-1",
          output: "fixture-private-output",
          exitCode: 2,
        });
        await options?.onItemEvent?.(
          projectAgentToolActivity({
            toolCallId: "exec-1",
            name: "exec",
            phase: "result",
            args: { command: "echo fixture-private-token" },
            isError: true,
          }),
        );
        await waitForBotApiCall(
          (call) =>
            call.method === "editMessageText" && String(call.fields.text).includes("failed"),
        );
        const card = [...visibleMessages.values()][0] ?? "";
        expect(card.match(/Exec/gu)).toHaveLength(1);
        expect(card).toContain("failed");
      },
      {
        mode: "progress",
        toolProgress: true,
        telegramCfg: {
          streaming: { mode: "progress", progress: { toolProgress: true, commandText: "status" } },
        },
        finalReply: { text: "The command failed." },
      },
    );
    const writes = JSON.stringify(calls.map((call) => call.fields.text));
    expect(writes).not.toContain("Formatted summary");
    expect(writes).not.toContain("fixture-private-output");
    expect(writes).not.toContain("command echo");
    expect(writes).not.toContain("fixture-private-token");
  });

  it.each(["progress", "off"] as const)(
    "reports tool-result acceptance without duplicate notices (%s)",
    async (mode) => {
      await dispatchProgressTurn(
        async (options, channelOptions) => {
          const beforeEmpty = calls.length;
          expect(await channelOptions?.onToolResult?.({ text: " \n " })).toBe(false);
          expect(calls.slice(beforeEmpty).filter((call) => call.method === "sendMessage")).toEqual(
            [],
          );
          if (mode === "progress") {
            // A preamble replaces reasoning rows, so verify token updates before it arrives.
            await options?.onReasoningProgress?.({ progressTokens: 50 });
            await options?.onReasoningProgress?.({ progressTokens: 200 });
            await waitForBotApiCall((call) => String(call.fields.text).includes("200 tokens"));
            const card = [...visibleMessages.values()][0] ?? "";
            expect(card).toContain("200 tokens");
            expect(card).not.toContain("50 tokens");
            expect(card.match(/tokens/gu)).toHaveLength(1);
            await options?.onItemEvent?.({
              kind: "preamble",
              itemId: "callback-preamble",
              phase: "end",
              progressText: "Checking the queued work",
            });
            expect(
              await channelOptions?.onToolResult?.({
                text: "Agents summary",
                channelData: { openclawToolProgressId: "tool:dynamic-1" },
              }),
            ).toBe(true);
            await emitToolStart(options, {
              name: "agents_list",
              phase: "start",
              toolCallId: "dynamic-1",
            });
          }
          expect(
            await channelOptions?.onToolResult?.({
              text: "Fast mode enabled",
              channelData: { openclawProgressKind: "fast-mode-auto" },
            }),
          ).toBe(true);
          await waitForBotApiCall((call) => String(call.fields.text).includes("Fast mode enabled"));
          expect(
            [...visibleMessages.values()].join("\n").match(/Fast mode enabled/gu),
          ).toHaveLength(1);
          if (mode === "progress") {
            expect([...visibleMessages.values()][0]).toContain("Checking the queued work");
            expect([...visibleMessages.values()][0]?.match(/Agents/gu)).toHaveLength(1);
            expect([...visibleMessages.values()][0]).not.toContain("Agents summary");
            expect([...visibleMessages.values()][0]).not.toContain("tokens");
          }
        },
        { mode, toolProgress: true, finalReply: { text: "The queued work is complete." } },
      );
      if (mode === "off") {
        expect([...visibleMessages.values()]).toEqual([
          "Fast mode enabled",
          "The queued work is complete.",
        ]);
      }
    },
  );

  it.each([
    { verbose: "on", mode: "progress", toolProgress: undefined, visible: true },
    { verbose: "full", mode: "progress", toolProgress: undefined, visible: true },
    { verbose: "off", mode: "progress", toolProgress: undefined, visible: false },
    { verbose: "on", mode: "progress", toolProgress: false, visible: false },
    { verbose: "full", mode: "progress", toolProgress: true, visible: true },
    { verbose: "on", mode: "partial", toolProgress: undefined, visible: true },
    { verbose: "on", mode: "off", toolProgress: undefined, visible: false },
  ] as const)(
    "keeps verbose $verbose diagnostics separate from $mode drafts (toolProgress=$toolProgress)",
    async ({ verbose, mode, toolProgress, visible }) => {
      const diagnostic =
        verbose === "full" ? "fixture stdout line one\nfixture stdout line two" : "Exec";
      await dispatchProgressTurn(
        async (options) => {
          await options?.onItemEvent?.({
            kind: "preamble",
            itemId: "verbose-commentary",
            phase: "end",
            progressText: "Inspecting the requested files",
          });
          await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "stdout" });
          await options?.onToolResult?.({ text: diagnostic });
        },
        {
          mode,
          toolProgress: true,
          telegramCfg: {
            streaming: { mode, progress: { toolProgress }, preview: { toolProgress } },
          },
          cfg: { agents: { defaults: { verboseDefault: verbose } } },
          finalReply: { text: "Inspection complete." },
        },
      );
      expect([...visibleMessages.values()].filter((text) => text === diagnostic)).toHaveLength(
        visible ? 1 : 0,
      );
      expect([...visibleMessages.values()]).toContain("Inspection complete.");
      if (mode === "progress") {
        expect([...visibleMessages.values()]).not.toContain("Inspecting the requested files");
      }
    },
  );
});
