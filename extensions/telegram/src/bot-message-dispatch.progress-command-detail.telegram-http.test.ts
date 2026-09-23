import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Bot } from "grammy";
import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { dispatchInboundMessage } from "openclaw/plugin-sdk/reply-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
import type { TelegramDraftStream } from "./draft-stream.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramReplyFenceForTest,
} from "./runtime.test-support.js";

type RecordedBotApiCall = { method: string; fields: Record<string, unknown> };
type ReplyResolver = NonNullable<Parameters<typeof dispatchInboundMessage>[0]["replyResolver"]>;

const BOT_TOKEN = "123456:telegram-progress-http-fixture";
const CHAT_ID = 123;

describe("Telegram progress command detail through the shared dispatcher and Telegram HTTP", () => {
  let server: Server;
  let apiRoot: string;
  let nextMessageId = 0;
  let inboundSequence = 0;
  const sockets = new Set<Socket>();
  const calls: RecordedBotApiCall[] = [];
  const visibleMessages = new Map<number, string>();
  let rejectNextQuote = false;

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        const fields = request.headers["content-type"]?.includes("application/json")
          ? (JSON.parse(body) as Record<string, unknown>)
          : Object.fromEntries(new URLSearchParams(body));
        const method = request.url?.split("/").at(-1) ?? "";
        calls.push({ method, fields });
        response.setHeader("content-type", "application/json");
        if (
          method === "sendMessage" &&
          rejectNextQuote &&
          fields.reply_parameters &&
          typeof fields.reply_parameters === "object" &&
          "quote" in fields.reply_parameters
        ) {
          rejectNextQuote = false;
          response.writeHead(400).end(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: "Bad Request: quote not found",
            }),
          );
          return;
        }
        if (method === "sendMessage" || method === "editMessageText") {
          const messageId =
            typeof fields.message_id === "number" ? fields.message_id : ++nextMessageId;
          visibleMessages.set(messageId, typeof fields.text === "string" ? fields.text : "");
          response.end(
            JSON.stringify({
              ok: true,
              result: {
                message_id: messageId,
                date: 1_700_000_000,
                chat: { id: CHAT_ID, type: "private" },
                text: typeof fields.text === "string" ? fields.text : "",
              },
            }),
          );
          return;
        }
        if (method === "deleteMessage") {
          visibleMessages.delete(Number(fields.message_id));
        }
        response.end(JSON.stringify({ ok: true, result: true }));
      });
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    calls.length = 0;
    visibleMessages.clear();
    rejectNextQuote = false;
    nextMessageId = 0;
    resetPluginStateStoreForTests({ closeDatabase: false });
    resetTelegramReplyFenceForTest();
    setTelegramPluginStateRuntimeForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function waitForBotApiCall(predicate: (call: RecordedBotApiCall) => boolean) {
    const deadline = Date.now() + 5_000;
    while (!calls.some(predicate)) {
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for a Bot API call");
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  }

  afterAll(async () => {
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function createContext(): TelegramMessageContext {
    const text = "Run the failing command.";
    // Each turn is a new inbound message; a repeated id is dropped as a duplicate.
    const inboundMessageId = 456 + inboundSequence++;
    const base = {
      ctxPayload: {
        Body: text,
        BodyForAgent: text,
        RawBody: text,
        CommandBody: text,
        ChatType: "direct",
        From: String(CHAT_ID),
        To: String(CHAT_ID),
        MessageSid: String(inboundMessageId),
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: `agent:default:telegram:direct:${CHAT_ID}`,
        Timestamp: 1_700_000_000_000,
      },
      primaryCtx: { message: { chat: { id: CHAT_ID, type: "private" } } },
      msg: { chat: { id: CHAT_ID, type: "private" }, message_id: inboundMessageId, text },
      chatId: CHAT_ID,
      isGroup: false,
      isForum: false,
      groupConfig: undefined,
      resolvedThreadId: undefined,
      replyThreadId: undefined,
      threadSpec: { id: undefined, scope: "none" },
      historyKey: undefined,
      historyLimit: 0,
      route: {
        agentId: "default",
        accountId: "default",
        sessionKey: `agent:default:telegram:direct:${CHAT_ID}`,
      },
      skillFilter: undefined,
      sendTyping: async () => undefined,
      sendRecordVoice: async () => undefined,
      sendChatActionHandler: { sendChatAction: async () => undefined },
      ackReactionPromise: null,
      reactionApi: null,
      statusReactionController: null,
      accountId: "default",
      turn: {
        storePath: "/tmp/openclaw/telegram-progress-http-sessions.json",
        recordInboundSession: async () => undefined,
        record: { onRecordError: () => undefined },
      },
    };
    return base as unknown as TelegramMessageContext;
  }

  type ReplyResolverOptions = Parameters<ReplyResolver>[1];

  async function emitToolStart(
    options: ReplyResolverOptions,
    payload: {
      toolCallId: string;
      name: string;
      phase: "start" | "update";
      args?: Record<string, unknown>;
    },
  ) {
    await options?.onItemEvent?.(projectAgentToolActivity(payload));
    await options?.onToolStart?.(payload);
  }

  async function dispatchProgressTurn(
    emitEvents: (options: ReplyResolverOptions) => Promise<void>,
    scenario?: {
      mode: "partial" | "progress";
      toolProgress: boolean;
      finalReply: ReplyPayload;
      replyToMode?: "all" | "first";
      accountId?: string;
      telegramDeps?: TelegramBotDeps;
    },
  ) {
    const replyResolver: ReplyResolver = async (_ctx, options) => {
      await options?.onReplyStart?.();
      await options?.onAssistantMessageStart?.();
      await emitEvents(options);
      // The final answer follows the finished progress edit, as a model that
      // answers after reading the command output does. Earlier edits may flush
      // first (attention statuses bypass the edit throttle).
      if (!scenario) {
        await waitForBotApiCall(
          (call) =>
            call.method === "editMessageText" && String(call.fields.text).includes("failed"),
        );
      }
      return scenario?.finalReply ?? { text: "The command failed." };
    };
    const telegramCfg = {
      botToken: BOT_TOKEN,
      apiRoot,
      streaming: {
        mode: scenario?.mode ?? "progress",
        preview: { toolProgress: scenario?.toolProgress ?? true, commandText: "raw" },
        progress: { toolProgress: true, commandText: "raw" },
      },
    } as const;
    const cfg = {
      channels: {
        telegram: scenario?.accountId
          ? {
              enabled: true,
              defaultAccount: scenario.accountId,
              accounts: {
                [scenario.accountId]: {
                  ...telegramCfg,
                  replyToMode: scenario.replyToMode,
                  richMessages: false,
                  streaming: { ...telegramCfg.streaming, block: { enabled: false } },
                },
              },
            }
          : telegramCfg,
      },
    };
    const errors: string[] = [];
    const context = createContext();
    if (scenario?.accountId) {
      context.accountId = scenario.accountId;
      context.route.accountId = scenario.accountId;
      context.ctxPayload.AccountId = scenario.accountId;
    }

    const result = await dispatchTelegramMessage({
      context,
      bot: new Bot(BOT_TOKEN, { client: { apiRoot } }),
      cfg,
      runtime: {
        log: () => undefined,
        error: (...args: unknown[]) => {
          errors.push(args.map(String).join(" "));
        },
        exit: () => {
          throw new Error("exit");
        },
      },
      replyToMode: scenario?.replyToMode ?? "off",
      streamMode: scenario?.mode ?? "progress",
      textLimit: 4096,
      telegramCfg,
      telegramDeps: scenario?.telegramDeps,
      opts: {
        token: BOT_TOKEN,
        dispatchReplyFromConfig: async (params) =>
          await dispatchInboundMessage({
            ctx: params.ctx,
            cfg: params.cfg,
            dispatcher: params.dispatcher,
            replyOptions: params.replyOptions,
            onSessionMetadataChanges: params.onSessionMetadataChanges,
            replyResolver,
          }),
      },
    });

    expect(errors).toEqual([]);
    expect(result).toEqual({ kind: "completed" });
    return calls
      .filter((call) => call.method === "sendMessage" || call.method === "editMessageText")
      .map((call) => [call.method, call.fields.message_id ?? null, call.fields.text] as const);
  }

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
        channel: "telegram",
        accountId: "default",
        to: String(CHAT_ID),
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
    "finalizes a current-message quote in place (quote rejected: %s)",
    async (quoteRejected) => {
      const intro =
        "The complete explanation retains the original delivery context and all literal examples.";
      const fenced = "  [[reply_to_current]]\n  MEDIA:./fenced-example.txt";
      const preview = `${intro}\n\n\`\`\`text\n${fenced}`;
      const text = `${preview}\n\`\`\`\n\n    [[reply_to_current]]\n    MEDIA:./indented-example.txt\n\nDone.`;
      rejectNextQuote = quoteRejected;
      await dispatchProgressTurn(
        async (options) => {
          await options?.onPartialReply?.({ text: preview, delta: preview });
          await waitForBotApiCall((call) => call.method === "sendMessage");
          await options?.onPartialReply?.({ text, replace: true });
        },
        {
          mode: "partial",
          toolProgress: false,
          replyToMode: "all",
          accountId: "sut",
          finalReply: { text, replyToCurrent: true },
        },
      );
      expect(visibleMessages.size).toBe(1);
      expect([...visibleMessages.values()]).toEqual([
        `${intro}\n\n<pre><code class="language-text">${fenced}\n</code></pre>\n<pre><code>[[reply_to_current]]\nMEDIA:./indented-example.txt\n</code></pre>\nDone.`,
      ]);
      const sends = calls.filter((call) => call.method === "sendMessage");
      expect(sends).toHaveLength(quoteRejected ? 2 : 1);
      expect(sends[0]?.fields.reply_parameters).toMatchObject({
        quote: "Run the failing command.",
        quote_position: 0,
      });
      if (quoteRejected) {
        expect(sends[1]?.fields).toMatchObject({
          reply_to_message_id: expect.any(Number),
          allow_sending_without_reply: true,
        });
        expect(sends[0]?.fields.reply_parameters).toMatchObject({
          message_id: sends[1]?.fields.reply_to_message_id,
        });
        expect(sends[1]?.fields).not.toHaveProperty("reply_parameters");
      }
      const edits = calls.filter((call) => call.method === "editMessageText");
      expect(edits.length).toBeGreaterThan(0);
      expect(edits.every((call) => call.fields.message_id === 1)).toBe(true);
      expect(calls.some((call) => call.method === "deleteMessage")).toBe(false);
    },
  );

  it("replies to the inbound message after a first-mode preview releases its target", async () => {
    const { defaultTelegramBotDeps } = await import("./bot-deps.js");
    const { createTelegramDraftStream } = await import("./draft-stream.js");
    const draftStreams: TelegramDraftStream[] = [];
    const inboundId = 456 + inboundSequence;
    const preview = "The requested result is ready, and I am completing the final explanation.";
    const finalText = `${preview} Done.`;
    await dispatchProgressTurn(
      async (options) => {
        await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "first" });
        await waitForBotApiCall(
          (call) => call.method === "sendMessage" && String(call.fields.text).includes("Exec"),
        );
        await options?.onAssistantMessageStart?.();
        await options?.onPartialReply?.({ text: preview, delta: preview });
        await waitForBotApiCall(
          (call) => call.method === "sendMessage" && call.fields.text === preview,
        );
        const sends = calls.filter((call) => call.method === "sendMessage");
        expect(sends).toHaveLength(2);
        expect(sends[0]?.fields.reply_parameters).toMatchObject({ message_id: inboundId });
        expect(sends[1]?.fields).not.toHaveProperty("reply_parameters");
        expect(sends[1]?.fields).not.toHaveProperty("reply_to_message_id");
        await expect
          .poll(
            () => draftStreams.find((stream) => stream.messageId() === 2)?.hasConsumedReplyTarget(),
            { timeout: 5_000 },
          )
          .toBe(false);
        expect(
          calls.some((call) => call.method === "deleteMessage" && call.fields.message_id === 1),
        ).toBe(true);
      },
      {
        mode: "partial",
        toolProgress: true,
        replyToMode: "first",
        accountId: "sut",
        finalReply: { text: finalText, replyToCurrent: true },
        telegramDeps: {
          ...defaultTelegramBotDeps,
          createTelegramDraftStream: (params) => {
            const stream = createTelegramDraftStream(params);
            draftStreams.push(stream);
            return stream;
          },
        },
      },
    );
    await expect.poll(() => [...visibleMessages.values()], { timeout: 5_000 }).toEqual([finalText]);
    const finalSend = calls.find(
      (call) => call.method === "sendMessage" && call.fields.text === finalText,
    );
    expect(
      finalSend?.fields.reply_parameters,
      JSON.stringify({ calls, visibleMessages: [...visibleMessages] }),
    ).toMatchObject({
      message_id: inboundId,
      quote: "Run the failing command.",
      quote_position: 0,
    });
    expect([...visibleMessages.keys()]).toEqual([3]);
  });

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
          if (assistantBoundary) {
            await options?.onAssistantMessageStart?.();
          }
          expect([...visibleMessages.values()]).toEqual([expect.stringContaining("Exec")]);
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

  it.each([false, true])(
    "does not prefix a terminal error with pre-tool text (tool progress: %s)",
    async (toolProgress) => {
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

      await expect
        .poll(() => [...visibleMessages.values()], { timeout: 5_000 })
        .toEqual([finalText]);
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

  it("keeps the raw command text on the finished progress line instead of the output title", async () => {
    // Same event sequence as the dispatch unit fixture: the exec tool starts with
    // command "false", then its output event restates the command as its item
    // title ("command false") and reports a nonzero exit.
    const revisions = await dispatchProgressTurn(async (options) => {
      await emitToolStart(options, {
        name: "exec",
        phase: "start",
        toolCallId: "exec-1",
        args: { command: "false" },
      });
      await waitForBotApiCall(
        (call) => call.method === "sendMessage" && String(call.fields.text).includes("Exec"),
      );
      await options?.onCommandOutput?.({
        phase: "end",
        title: "command false",
        name: "exec",
        toolCallId: "exec-1",
        output: "No such file or directory",
        exitCode: 2,
      });
      await options?.onItemEvent?.(
        projectAgentToolActivity({
          toolCallId: "exec-1",
          name: "exec",
          phase: "result",
          args: { command: "false" },
          isError: true,
        }),
      );
    });

    // One progress message: sent with the running command line, edited in place
    // with the finished line, then the final answer arrives as its own message.
    expect(revisions).toEqual([
      ["sendMessage", null, "<b>Working</b>\n<b>🛠️ Exec</b> false <i>running</i>"],
      ["editMessageText", 1, "<b>Working</b>\n<b>🛠️ Exec</b> false <i>failed</i>"],
      ["sendMessage", null, "The command failed."],
    ]);
    for (const call of calls) {
      expect(call.fields.text ?? "").not.toContain("command false");
    }
  });

  it("keeps the command text through the embedded producer's terminal command item", async () => {
    // The embedded exec producer's event order for one failing command: the
    // tool start, the tool and command items opening, a status-only output
    // projected from the tool result, the tool and command items ending with a
    // terminal status, then the command_output event titled "command false".
    const revisions = await dispatchProgressTurn(async (options) => {
      await emitToolStart(options, {
        name: "exec",
        phase: "start",
        toolCallId: "exec-1",
        args: { command: "false" },
      });
      await waitForBotApiCall(
        (call) => call.method === "sendMessage" && String(call.fields.text).includes("Exec"),
      );
      await options?.onItemEvent?.({
        itemId: "tool:exec-1",
        kind: "tool",
        title: "exec false",
        phase: "start",
        status: "running",
        name: "exec",
        meta: "false",
        toolCallId: "exec-1",
        commandBearing: true,
      });
      await options?.onItemEvent?.({
        itemId: "command:exec-1",
        kind: "command",
        suppressChannelProgress: true,
        title: "command false",
        phase: "start",
        status: "running",
        name: "exec",
        meta: "false",
        toolCallId: "exec-1",
      });
      await options?.onCommandOutput?.({
        phase: "end",
        name: "exec",
        toolCallId: "exec-1",
        output: "No such file or directory",
        status: "failed",
        exitCode: 2,
      });
      await options?.onItemEvent?.({
        itemId: "tool:exec-1",
        kind: "tool",
        title: "exec false",
        phase: "end",
        status: "failed",
        name: "exec",
        meta: "false",
        toolCallId: "exec-1",
        commandBearing: true,
      });
      await options?.onItemEvent?.({
        itemId: "command:exec-1",
        kind: "command",
        suppressChannelProgress: true,
        title: "command false",
        phase: "end",
        status: "failed",
        name: "exec",
        meta: "false",
        toolCallId: "exec-1",
        summary: "No such file or directory",
      });
      await options?.onCommandOutput?.({
        itemId: "command:exec-1",
        phase: "end",
        title: "command false",
        name: "exec",
        toolCallId: "exec-1",
        output: "No such file or directory",
        status: "failed",
        exitCode: 2,
      });
    });

    // Intermediate item revisions may coalesce under the edit throttle, so the
    // sequence is checked by shape: the progress message opens with the running
    // command line, every edit targets that message and keeps the command text,
    // the last edit carries the exit status, and the final answer is separate.
    expect(revisions[0]).toEqual([
      "sendMessage",
      null,
      "<b>Working</b>\n<b>🛠️ Exec</b> false <i>running</i>",
    ]);
    expect(revisions.at(-1)).toEqual(["sendMessage", null, "The command failed."]);
    const edits = revisions.filter(([method]) => method === "editMessageText");
    expect(edits.length).toBeGreaterThan(0);
    for (const [, messageId, text] of edits) {
      expect(messageId).toBe(1);
      expect(text).toContain("<b>🛠️ Exec</b> false");
    }
    expect(edits.at(-1)?.[2]).toBe("<b>Working</b>\n<b>🛠️ Exec</b> false <i>failed</i>");
    for (const call of calls) {
      expect(call.fields.text ?? "").not.toContain("command false");
    }
  });
});
