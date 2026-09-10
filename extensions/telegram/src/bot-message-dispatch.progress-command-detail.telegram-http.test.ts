import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Bot } from "grammy";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { dispatchInboundMessage } from "openclaw/plugin-sdk/reply-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TelegramMessageContext } from "./bot-message-context.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramReplyFenceForTest,
} from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

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
        if (method === "sendMessage" || method === "editMessageText") {
          const messageId =
            typeof fields.message_id === "number" ? fields.message_id : ++nextMessageId;
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
    nextMessageId = 0;
    resetPluginStateStoreForTests({ closeDatabase: false });
    resetTelegramReplyFenceForTest();
    setTelegramRuntime({
      state: {
        openKeyedStore: ((options) =>
          createPluginStateKeyedStoreForTests(
            "telegram",
            options,
          )) as TelegramRuntime["state"]["openKeyedStore"],
        openSyncKeyedStore: ((options) =>
          createPluginStateSyncKeyedStoreForTests(
            "telegram",
            options,
          )) as TelegramRuntime["state"]["openSyncKeyedStore"],
      },
      channel: {},
    } as TelegramRuntime);
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
      msg: { chat: { id: CHAT_ID, type: "private" }, message_id: inboundMessageId },
      chatId: CHAT_ID,
      isGroup: false,
      isForum: false,
      groupConfig: undefined,
      resolvedThreadId: undefined,
      replyThreadId: undefined,
      threadSpec: { id: undefined, scope: "none" },
      historyKey: undefined,
      historyLimit: 0,
      groupHistories: new Map(),
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

  async function dispatchProgressTurn(
    emitEvents: (options: ReplyResolverOptions) => Promise<void>,
  ) {
    const replyResolver: ReplyResolver = async (_ctx, options) => {
      await options?.onReplyStart?.();
      await options?.onAssistantMessageStart?.();
      await emitEvents(options);
      // The final answer follows the finished progress edit, as a model that
      // answers after reading the command output does. Earlier edits may flush
      // first (attention statuses bypass the edit throttle).
      await waitForBotApiCall(
        (call) => call.method === "editMessageText" && String(call.fields.text).includes("exit 2"),
      );
      return { text: "The command failed." };
    };
    const telegramCfg = {
      botToken: BOT_TOKEN,
      apiRoot,
      streaming: { mode: "progress", progress: { toolProgress: true, commandText: "raw" } },
    } as const;
    const cfg = { channels: { telegram: telegramCfg } };
    const errors: string[] = [];

    const result = await dispatchTelegramMessage({
      context: createContext(),
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
      replyToMode: "off",
      streamMode: "progress",
      textLimit: 4096,
      telegramCfg,
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

  it("keeps the raw command text on the finished progress line instead of the output title", async () => {
    // Same event sequence as the dispatch unit fixture: the exec tool starts with
    // command "false", then its output event restates the command as its item
    // title ("command false") and reports a nonzero exit.
    const revisions = await dispatchProgressTurn(async (options) => {
      await options?.onToolStart?.({
        name: "exec",
        phase: "start",
        toolCallId: "exec-1",
        args: { command: "false" },
      });
      await options?.onCommandOutput?.({
        phase: "end",
        title: "command false",
        name: "exec",
        toolCallId: "exec-1",
        output: "No such file or directory",
        exitCode: 2,
      });
    });

    // One progress message: sent with the running command line, edited in place
    // with the finished line, then the final answer arrives as its own message.
    expect(revisions).toEqual([
      ["sendMessage", null, "<b>Working</b>\n<b>🛠️ Exec</b> false"],
      ["editMessageText", 1, "<b>Working</b>\n<b>🛠️ Exec</b> false <i>exit 2</i>"],
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
      await options?.onToolStart?.({
        itemId: "tool:exec-1",
        name: "exec",
        phase: "start",
        toolCallId: "exec-1",
        args: { command: "false" },
      });
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
    expect(revisions[0]).toEqual(["sendMessage", null, "<b>Working</b>\n<b>🛠️ Exec</b> false"]);
    expect(revisions.at(-1)).toEqual(["sendMessage", null, "The command failed."]);
    const edits = revisions.filter(([method]) => method === "editMessageText");
    expect(edits.length).toBeGreaterThan(0);
    for (const [, messageId, text] of edits) {
      expect(messageId).toBe(1);
      expect(text).toContain("<b>🛠️ Exec</b> false");
    }
    expect(edits.at(-1)?.[2]).toBe("<b>Working</b>\n<b>🛠️ Exec</b> false <i>exit 2</i>");
    for (const call of calls) {
      expect(call.fields.text ?? "").not.toContain("command false");
    }
  });
});
