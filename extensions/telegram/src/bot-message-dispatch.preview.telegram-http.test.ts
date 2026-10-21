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
  const texts = () => [...visibleMessages.values()];
  const sends = () => acceptedCalls.filter((call) => call.method === "sendMessage");
  const sentTexts = () => sends().map((call) => call.fields.text);
  const waitForMethod = (method: string) => waitForBotApiCall((call) => call.method === method);
  const waitForText = (text: string, method?: string) =>
    waitForBotApiCall((call) => (!method || call.method === method) && call.fields.text === text);
  const waitForContaining = (text: string, method?: string) =>
    waitForBotApiCall(
      (call) => (!method || call.method === method) && String(call.fields.text).includes(text),
    );

  type Scenario = NonNullable<Parameters<typeof dispatchProgressTurn>[1]>;
  type Events = Parameters<typeof dispatchProgressTurn>[0];
  type Options = Parameters<Events>[0];
  function runTurn(events: Events, scenario: Partial<Scenario>) {
    return dispatchProgressTurn(events, { mode: "partial", toolProgress: false, ...scenario });
  }
  function assertContains(actual: unknown, ...expected: string[]) {
    for (const text of expected) {
      expect(actual).toContain(text);
    }
  }
  function assertExcludes(actual: unknown, ...unexpected: string[]) {
    for (const text of unexpected) {
      expect(actual).not.toContain(text);
    }
  }
  function produce(producer: NonNullable<Scenario["producer"]>, scenario: Partial<Scenario> = {}) {
    return runTurn(async () => undefined, { ...scenario, producer });
  }
  function installHook(hook: Omit<Parameters<typeof addTestHook>[0], "registry" | "pluginId">) {
    const registry = createEmptyPluginRegistry();
    addTestHook({ registry, pluginId: "http-policy", ...hook });
    initializeGlobalHookRunner(registry);
  }
  async function accepts(options: Options, text: string, channelData: ReplyPayload["channelData"]) {
    expect(await options?.onToolResult?.({ text, channelData })).toBe(true);
  }
  function emitPreamble(options: Options, progressText: string) {
    return options?.onItemEvent?.({
      kind: "preamble",
      itemId: "preamble",
      phase: "end",
      progressText,
    });
  }
  function tool(
    options: Parameters<typeof emitToolStart>[0],
    name: string,
    toolCallId: string,
    phase: "start" | "update" = "start",
    args?: Record<string, unknown>,
  ) {
    return emitToolStart(options, { name, toolCallId, phase, ...(args ? { args } : {}) });
  }

  it.each([
    ["partial", ""],
    ["block", ""],
    ["partial", "[bot] "],
    ["block", "[bot] "],
  ] as const)(
    "appends explicit chunks and replaces each final in %s mode with prefix %s",
    async (mode, prefix) => {
      const first = "This answer starts here and has enough text to preview. ";
      const chunk = "The next sentence belongs to the same answer. ";
      const finalText = "The authoritative final replaces the streamed draft.";
      await runTurn(async () => undefined, {
        mode,
        cfg: { messages: { responsePrefix: prefix.trimEnd() } },
        producer: async ({ dispatcher }) => {
          dispatcher.sendBlockReply({ text: first, textMode: "delta" });
          await dispatcher.waitForIdle();
          dispatcher.sendBlockReply({ text: chunk, textMode: "delta" });
          await dispatcher.waitForIdle();
          dispatcher.sendBlockReply({ text: first, textMode: "delta" });
          await dispatcher.waitForIdle();
          expect([...visibleMessages.values()]).toEqual([
            (prefix + first + chunk + first).trimEnd(),
          ]);
          dispatcher.sendFinalReply({ text: finalText });
          dispatcher.sendFinalReply({ text: "Separate status." });
          return { queuedFinal: true, counts: dispatcher.getQueuedCounts() };
        },
      });
      expect([...visibleMessages.values()]).toEqual([
        prefix + finalText,
        prefix + "Separate status.",
      ]);
    },
  );

  it("preserves accumulated ACP answer chunks when a final status notice follows", async () => {
    const first = "First ACP answer chunk with enough text for a preview. ";
    const second = "Second ACP answer chunk completes the answer.";
    await produce(async ({ dispatcher }) => {
      dispatcher.sendBlockReply({ text: first, textMode: "delta" });
      dispatcher.sendBlockReply({ text: second, textMode: "delta" });
      await dispatcher.waitForIdle();
      dispatcher.sendFinalReply({ text: "Session ids resolved.", isStatusNotice: true });
      return { queuedFinal: true, counts: dispatcher.getQueuedCounts() };
    });
    expect(texts()).toEqual([first + second, "Session ids resolved."]);
  });

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
    await runTurn(
      async (options) => {
        await options?.onPartialReply?.({ text: initial });
        await waitForMethod("sendMessage");
        await options?.onPartialReply?.({ text: updated });
        await waitForMethod("editMessageText");
      },
      { finalReply: { text: finalText } },
    );
    expect(rejected).toBe(true);
    expect(sends()).toHaveLength(1);
    expect([...visibleMessages]).toEqual([[1, finalText]]);
  });

  it("delivers hooked progress before final with message_sending in progress mode", async () => {
    const mode = "progress";
    installHook({
      hookName: "message_sending",
      handler: (event: { content: string }) => ({
        content: event.content.replace("fixture-secret", "filtered"),
      }),
    });
    await runTurn(
      async (options, channelOptions) => {
        expect(channelOptions?.disableBlockStreaming).toBe(false);
        await options?.onPartialReply?.({ text: "Unapproved partial fixture-secret" });
        expect(visibleMessages.size).toBe(0);
        await options?.onBlockReply?.({ text: "Checking fixture-secret while work continues." });
        await waitForText("Checking filtered while work continues.");
        expect(texts()).toEqual(["Checking filtered while work continues."]);
      },
      { mode, finalReply: { text: "Finished fixture-secret." } },
    );
    expect(texts()).toEqual(["Checking filtered while work continues.", "Finished filtered."]);
    expect(JSON.stringify(calls)).not.toContain("fixture-secret");
    expect(calls.some((call) => call.method === "editMessageText")).toBe(false);
    const expected = ["Checking filtered while work continues.", "Finished filtered."];
    for (const [label, config] of [
      ["Opted-out", { telegramCfg: { streaming: { mode, block: { enabled: false } } } }],
      ["Global-off", { cfg: { agents: { defaults: { blockStreamingDefault: "off" } } } }],
    ] as const) {
      await runTurn(
        async (_options, channelOptions) => {
          expect(channelOptions?.disableBlockStreaming).toBe(true);
        },
        { mode, ...config, finalReply: { text: `${label} final fixture-secret.` } },
      );
      expected.push(`${label} final filtered.`);
      expect(texts()).toEqual(expected);
    }
  });

  it.each([
    { hook: "reply_payload_sending", mode: "partial" },
    { hook: "message_sending", mode: "progress" },
  ] as const)("gates real preview writes with $hook in $mode mode", async ({ hook, mode }) => {
    const modifierEntered = createDeferred<void>();
    const releaseModifier = createDeferred<void>();
    if (hook === "reply_payload_sending") {
      installHook({
        hookName: hook,
        handler: async (event: PluginHookReplyPayloadSendingEvent) => {
          modifierEntered.resolve();
          await releaseModifier.promise;
          return { payload: { ...event.payload, text: "Allowed final" } };
        },
      });
    } else if (hook === "message_sending") {
      installHook({
        hookName: hook,
        handler: async () => {
          modifierEntered.resolve();
          await releaseModifier.promise;
          return { content: "Allowed final" };
        },
      });
    }
    const dispatched = runTurn(
      async (options) => {
        await options?.onPartialReply?.({
          text: "Pre-hook answer containing fixture-secret-answer",
        });
        await tool(options, "exec", "private-tool", "start", {
          command: "echo fixture-secret-command",
        });
        await options?.onReasoningStream?.({
          text: "<think>Independent reasoning containing fixture-secret-reasoning</think>",
        });
      },
      {
        mode,
        toolProgress: true,
        cfg: { agents: { defaults: { reasoningDefault: "stream" } } },
        finalReply: { text: "Pre-hook fixture-secret-final" },
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
    expect(texts()).toEqual(["Allowed final"]);
  });

  it("paginates quoted block finals without losing text or replacing the accepted preview", async () => {
    const mode = "block";
    const context = http.createContext();
    const expectedPages = ["A".repeat(600), "B".repeat(600), "C".repeat(600)];
    const finalText = expectedPages.join("");
    let preview: Array<[number, string]> = [];
    await runTurn(
      async (options) => {
        await options?.onPartialReply?.({ text: finalText });
        await waitForMethod("sendMessage");
        preview = [...visibleMessages];
      },
      {
        mode,
        context,
        replyToMode: "all",
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
    expect(sends()[0]?.fields.reply_parameters).toMatchObject({
      message_id: context.msg.message_id,
      quote: "Run the failing command.",
      quote_position: 0,
    });
    for (const call of sends()) {
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
    expect(pages.map(([, text]) => text)).toEqual(expectedPages);
  });

  it("keeps sending typing before Telegram expiry beyond the default pipeline cutoff", async () => {
    const acceptedTypingAt: number[] = [];
    http.respondToCall = (call) => {
      if (call.method === "sendChatAction" && call.fields.action === "typing") {
        acceptedTypingAt.push(Date.now());
      }
      return undefined;
    };
    await runTurn(
      async () => {
        await waitForMethod("sendChatAction");
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
      { mode: "off", finalReply: { text: "Long-running work complete." } },
    );
    const settledTypingCount = acceptedTypingAt.length;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(acceptedTypingAt).toHaveLength(settledTypingCount);
  });

  it.each(["control-only", "immediate", "buffered"] as const)(
    "delivers presentation controls through %s",
    async (branch) => {
      const blocks: NonNullable<ReplyPayload["presentation"]>["blocks"] = [];
      if (branch !== "control-only") {
        blocks.push(
          {
            type: "chart",
            chartType: "pie",
            title: "Revenue mix",
            segments: [{ label: "Product", value: 60 }],
          },
          {
            type: "table",
            caption: "Pipeline",
            headers: ["Account", "Stage"],
            rows: [["Acme", "Won"]],
          },
        );
      }
      blocks.push({
        type: "buttons",
        buttons: [
          { label: "Retry", value: "retry" },
          { label: "Launch", action: { type: "web-app", url: "https://example.com/app" } },
          { label: "Copy manually", value: "x".repeat(65) },
        ],
      });
      const controls: ReplyPayload = { presentation: { blocks } };
      if (branch === "buffered") {
        http.respondToCall = (call) =>
          String(call.fields.text).includes("first reasoning attempt")
            ? { error_code: 400, description: "Bad Request: reasoning rejected" }
            : undefined;
      }
      await runTurn(
        async (options) => {
          if (branch === "immediate") {
            await options?.onPartialReply?.({
              text: "The presentation is ready for review and selection.",
            });
            await waitForMethod("sendMessage");
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
            await waitForContaining("first reasoning attempt");
          }
        },
        {
          mode: branch === "control-only" ? "off" : "partial",
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
      const markup = JSON.stringify(visibleMarkup.get(answer![0]));
      assertContains(
        markup,
        '"callback_data":"retry"',
        '"web_app":{"url":"https://example.com/app"}',
      );
      expect(markup).not.toContain("x".repeat(65));
      if (branch !== "control-only") {
        assertContains(answer?.[1], "Revenue mix", "Product", "Acme", "Won");
      }
      if (branch === "buffered") {
        expect(String(sends()[0]?.fields.text)).toContain("accepted second reasoning attempt");
        expect(String(sends().at(-1)?.fields.text)).toContain("Revenue mix");
      } else if (branch === "immediate") {
        expect([...visibleMessages.keys()]).toEqual([1]);
      }
    },
  );
  it.each([false, true])(
    "retires lazy partials only on new tool starts (update=%s)",
    async (update) => {
      const answer = "The first result is ready, and the remaining work is still running.";
      const failure = "The provider failed. Please try again.";
      await runTurn(
        async (options) => {
          if (update) {
            await tool(options, "exec", "first");
            await options?.onAssistantMessageStart?.();
            await options?.onPartialReply?.({ text: answer, delta: answer });
            await waitForText(answer, "sendMessage");
            await tool(options, "exec", "first", "update");
          } else {
            // Callback start order matters: the queued partial must retire before the tool.
            const partial = options?.onPartialReply?.({ text: answer, delta: answer });
            const started = tool(options, "exec", "first");
            await Promise.all([partial, started]);
          }
        },
        { finalReply: { text: failure, isError: true } },
      );
      if (update) {
        expect(texts()).toEqual([`${answer}\n\n${failure}`]);
      } else {
        await expect.poll(texts, { timeout: 5_000 }).toEqual([failure]);
      }
    },
  );

  it.each([false, true])("preserves indexed blocks unless skipped (skip=%s)", async (skip) => {
    const firstText = "The first assistant answer reports findings from site A.";
    const answer = "The second assistant answer reports findings from site B.";
    const first = setReplyPayloadMetadata(
      { text: skip ? "NO_REPLY" : firstText },
      { assistantMessageIndex: 0, ...(skip ? { silentReply: true } : {}) },
    );
    const second = setReplyPayloadMetadata({ text: answer }, { assistantMessageIndex: 1 });
    let previewId: number | undefined;
    await produce(async ({ dispatcher, replyOptions }) => {
      if (skip) {
        await replyOptions?.onPartialReply?.({ text: firstText });
        await waitForText(firstText, "sendMessage");
        previewId = [...visibleMessages.keys()][0];
        await replyOptions?.onBlockReplyQueued?.(first, { assistantMessageIndex: 0 });
        await replyOptions?.onAssistantMessageStart?.();
        dispatcher.sendBlockReply(first);
        await replyOptions?.onPartialReply?.({ text: answer });
      } else {
        await replyOptions?.onBlockReplyQueued?.(first, { assistantMessageIndex: 0 });
        await replyOptions?.onBlockReplyQueued?.(second, { assistantMessageIndex: 1 });
        dispatcher.sendBlockReply(first);
        await waitForText(firstText, "sendMessage");
        previewId = [...visibleMessages.keys()][0];
        dispatcher.sendBlockReply(second);
      }
      dispatcher.sendFinalReply(skip ? { text: answer } : second);
      const counts = dispatcher.getQueuedCounts();
      return { queuedFinal: counts.final > 0, counts };
    });
    expect(texts()).toEqual(skip ? [answer] : [firstText, answer]);
    expect(sentTexts()).toEqual([firstText, answer]);
    if (skip) {
      expect(visibleMessages.has(previewId!)).toBe(false);
      expect(
        acceptedCalls
          .filter((call) => call.method === "deleteMessage")
          .map((call) => Number(call.fields.message_id)),
      ).toEqual([previewId]);
    } else {
      expect(visibleMessages.get(previewId!)).toBe(firstText);
    }
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
      await runTurn(
        async (options) => {
          if (terminalFailure) {
            options?.onAgentRunTerminalOutcome?.("failed");
          }
          throw new Error("private-provider-http-500");
        },
        {
          context,
          mode: "off",
          cfg: { messages: { groupChat: { visibleReplies: "message_tool" } } },
          telegramCfg: { silentErrorReplies: true },
          suppressFailureFallback: true,
          allowErrors: true,
          outcome: terminalFailure ? "completed" : "failed-retryable",
        },
      );
      const replies = sends();
      expect(replies).toHaveLength(terminalFailure ? 1 : 0);
      if (terminalFailure) {
        expect(replies[0]?.fields.text).toContain("Please try again.");
        expect(replies[0]?.fields.disable_notification).toBe(true);
      }
      expect(JSON.stringify(calls)).not.toContain("private-provider-http-500");
    },
  );
  it("preserves structured command detail against summaries with status privacy", async () => {
    await runTurn(
      async (options, channelOptions) => {
        await tool(options, "exec", "exec-1", "start", { command: "echo fixture-private-token" });
        await waitForContaining("Exec", "sendMessage");
        await accepts(channelOptions, "Formatted summary", {
          openclawToolProgressId: "tool:exec-1",
        });
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
        await waitForContaining("failed", "editMessageText");
        const card = [...visibleMessages.values()][0] ?? "";
        expect(card.match(/Exec/gu)).toHaveLength(1);
        assertContains(card, "🛠️ Exec", "failed");
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
    assertExcludes(
      writes,
      "Formatted summary",
      "fixture-private-output",
      "command echo",
      "fixture-private-token",
    );
  });

  it.each(["progress", "off"] as const)(
    "reports tool-result acceptance without duplicate notices (%s)",
    async (mode) => {
      await runTurn(
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
            await waitForContaining("200 tokens");
            const card = [...visibleMessages.values()][0] ?? "";
            expect(card).toContain("200 tokens");
            expect(card).not.toContain("50 tokens");
            expect(card.match(/tokens/gu)).toHaveLength(1);
            await emitPreamble(options, "Checking the queued work");
            await accepts(channelOptions, "Agents summary", {
              openclawToolProgressId: "tool:dynamic-1",
            });
            await tool(options, "agents_list", "dynamic-1");
          }
          await accepts(channelOptions, "Fast mode enabled", {
            openclawProgressKind: "fast-mode-auto",
          });
          await waitForContaining("Fast mode enabled");
          const notices = texts().join("\n");
          expect(notices.match(/Fast mode enabled/gu)).toHaveLength(1);
          if (mode === "progress") {
            expect(texts()[0]).toContain("Checking the queued work");
            expect(texts()[0]?.match(/Agents/gu)).toHaveLength(1);
            assertExcludes(texts()[0], "Agents summary", "tokens");
          }
        },
        { mode, toolProgress: true, finalReply: { text: "The queued work is complete." } },
      );
      if (mode === "off") {
        expect(texts()).toEqual(["Fast mode enabled", "The queued work is complete."]);
      }
    },
  );

  it.each([
    { verbose: "on", mode: "progress", toolProgress: undefined, visible: true, preamble: true },
    { verbose: "full", mode: "progress", toolProgress: undefined, visible: true, preamble: true },
    { verbose: "off", mode: "progress", toolProgress: undefined, visible: false, preamble: true },
    { verbose: "on", mode: "progress", toolProgress: false, visible: false, preamble: true },
    { verbose: "full", mode: "progress", toolProgress: true, visible: true, preamble: true },
    { verbose: "on", mode: "partial", toolProgress: undefined, visible: true, preamble: true },
    { verbose: "on", mode: "off", toolProgress: undefined, visible: false, preamble: true },
    { verbose: "on", mode: "progress", toolProgress: undefined, visible: true, preamble: false },
  ] as const)(
    "keeps verbose $verbose diagnostics separate from $mode drafts (toolProgress=$toolProgress, preamble=$preamble)",
    async ({ verbose, mode, toolProgress, visible, preamble }) => {
      const diagnostic =
        verbose === "full" ? "fixture stdout line one\nfixture stdout line two" : "Exec";
      await runTurn(
        async (options) => {
          if (preamble) {
            await emitPreamble(options, "Inspecting the requested files");
          }
          await tool(options, "exec", "stdout");
          await options?.onToolResult?.({ text: diagnostic });
          if (mode === "progress") {
            await vi.advanceTimersByTimeAsync(2_000);
          }
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
        expect(
          acceptedCalls.some((call) =>
            String(call.fields.text).includes("Inspecting the requested files"),
          ),
        ).toBe(preamble);
        expect(texts()).not.toContain("Inspecting the requested files");
        if (!preamble) {
          expect(sentTexts()).toEqual([diagnostic, "Inspection complete."]);
        }
      }
    },
  );

  it.each([
    ["direct", "automatic", false],
    ["direct", "automatic", true],
    ["direct", "message_tool", false],
    ["direct", "message_tool", true],
    ["group", "automatic", false],
    ["group", "automatic", true],
    ["group", "message_tool", false],
    ["group", "message_tool", true],
  ] as const)(
    "respects send denial for %s/%s commentary (denied=%s)",
    async (chat, ownership, denied) => {
      const commentary = "Checking the requested workspace.";
      const finalText = "The requested inspection is complete.";
      const context = http.createContext();
      context.isGroup = chat === "group";
      context.ctxPayload.ChatType = chat;
      context.ctxPayload.WasMentioned = chat === "group";
      if (chat === "group") {
        const group = { id: -100123, type: "supergroup" as const, title: "Inspection fixture" };
        context.chatId = group.id;
        context.msg.chat = group;
        context.primaryCtx.message.chat = group;
        context.route.sessionKey = "agent:default:telegram:group:-100123";
        Object.assign(context.ctxPayload, {
          SessionKey: context.route.sessionKey,
          From: "telegram:group:-100123",
          To: "telegram:-100123",
        });
      }
      await runTurn(
        async (options) => {
          await options?.onReasoningProgress?.({ progressTokens: 200 });
          await emitPreamble(options, commentary);
          await tool(options, "exec", "inspect-tool");
          if (!denied) {
            await waitForContaining(commentary);
            expect(texts().join("\n")).toContain(commentary);
          }
        },
        {
          mode: "progress",
          context,
          telegramCfg: {
            streaming: { mode: "progress", progress: { commentary: true, toolProgress: true } },
          },
          cfg: {
            messages: { visibleReplies: ownership, groupChat: { visibleReplies: ownership } },
            ...(denied ? { session: { sendPolicy: { default: "deny" } } } : {}),
          },
          finalReply: { text: finalText },
        },
      );
      if (denied) {
        expect(
          calls.filter((call) =>
            ["sendMessage", "editMessageText", "deleteMessage", "sendChatAction"].includes(
              call.method,
            ),
          ),
        ).toEqual([]);
      } else {
        expect(calls.some((call) => call.method === "deleteMessage")).toBe(true);
      }
      expect(texts()).toEqual(!denied && ownership === "automatic" ? [finalText] : []);
    },
  );
});
