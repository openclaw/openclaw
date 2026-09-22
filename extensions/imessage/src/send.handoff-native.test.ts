import fs from "node:fs";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IMessageRpcClient } from "./client.js";
import { loadFreshIMessageReplyCacheForTest } from "./test-support/runtime.js";

type SendMessage = typeof import("./send.js").sendMessageIMessage;
type NativeRpcRequest = {
  id: number;
  method: string;
  params: Record<string, unknown>;
};
type NativeRecord = { kind: "cli"; args: string[] } | { kind: "rpc"; request: NativeRpcRequest };
type NativeMode = "group" | "thread" | "accepted" | "immediate";

function createNativeFixture(state: OpenClawTestState, mode: NativeMode) {
  const cliPath = state.path("synthetic-imsg.cjs");
  const dbPath = state.path("unused-synthetic-chat.db");
  const logPath = state.path("native-requests.jsonl");
  const releasePath = state.path("release-native-response");
  fs.writeFileSync(logPath, "");
  fs.writeFileSync(
    cliPath,
    [
      "#!" + process.execPath,
      'const fs = require("node:fs");',
      'const readline = require("node:readline");',
      'const { setTimeout: delay } = require("node:timers/promises");',
      "const mode = " + JSON.stringify(mode) + ";",
      "const logPath = " + JSON.stringify(logPath) + ";",
      "const releasePath = " + JSON.stringify(releasePath) + ";",
      "const args = process.argv.slice(2);",
      'const record = (value) => fs.appendFileSync(logPath, JSON.stringify(value) + "\\n");',
      'const write = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
      "const fail = (error) => {",
      '  process.stderr.write(String(error) + "\\n");',
      "  process.exit(1);",
      "};",
      "async function waitForRelease() {",
      "  const deadline = Date.now() + 15000;",
      "  while (!fs.existsSync(releasePath)) {",
      '    if (Date.now() >= deadline) throw new Error("synthetic response gate timed out");',
      "    await delay(5);",
      "  }",
      "}",
      'if (args[0] === "rpc") {',
      "  async function handle(request) {",
      '    record({ kind: "rpc", request });',
      '    if (mode === "thread" && request.params.reply_to) {',
      "      await waitForRelease();",
      "      write({",
      '        jsonrpc: "2.0", id: request.id,',
      "        error: {",
      "          code: -32602,",
      '          message: "reply_to requires bridge transport; AppleScript fallback cannot send threaded replies"',
      "        }",
      "      });",
      "      return;",
      "    }",
      '    if (mode === "accepted" && request.params.text === "caller A") {',
      "      await waitForRelease();",
      "    }",
      '    const guid = request.params.text === "caller A" ? "p:0/caller-a" :',
      '      request.params.text === "caller B" ? "p:0/caller-b" : "p:0/native-send";',
      '    write({ jsonrpc: "2.0", id: request.id, result: { guid, status: "sent" } });',
      "  }",
      '  readline.createInterface({ input: process.stdin }).on("line", (line) => {',
      "    void handle(JSON.parse(line)).catch(fail);",
      "  });",
      "} else {",
      "  async function run() {",
      '    record({ kind: "cli", args });',
      '    if (mode === "group" && args[0] === "group") await waitForRelease();',
      '    const fileIndex = args.indexOf("--file");',
      "    if (fileIndex >= 0 && !fs.existsSync(args[fileIndex + 1])) {",
      '      throw new Error("synthetic attachment file is missing");',
      "    }",
      '    write(args[0] === "group" ? { guid: "iMessage;+;synthetic-chat" } :',
      '      { success: true, messageGuid: "p:0/native-attachment" });',
      "  }",
      "  void run().catch(fail);",
      "}",
    ].join("\n"),
    { mode: 0o755 },
  );
  const readRecords = (): NativeRecord[] =>
    fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as NativeRecord);
  return {
    cliPath,
    dbPath,
    options: {
      config: { channels: { imessage: { accounts: { work: { cliPath, dbPath } } } } },
      accountId: "work",
    },
    release: () => fs.writeFileSync(releasePath, ""),
    readRecords,
    readRequests: () =>
      readRecords().flatMap((record) => (record.kind === "rpc" ? [record.request] : [])),
  };
}

function observeSend(sending: ReturnType<SendMessage>) {
  return sending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

describe("iMessage caller authority at native request boundaries", () => {
  let state: OpenClawTestState;
  let sendMessageIMessage: SendMessage;
  let createIMessageRpcClient: typeof import("./client.js").createIMessageRpcClient;
  let rememberIMessageReplyCache: typeof import("./monitor-reply-cache.js").rememberIMessageReplyCache;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-imessage-handoff-native-",
    });
    ({ rememberIMessageReplyCache } = await loadFreshIMessageReplyCacheForTest());
    ({ sendMessageIMessage } = await import("./send.js"));
    ({ createIMessageRpcClient } = await import("./client.js"));
    // Every executable path below belongs to this fixture, including RPC startup.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await state.cleanup();
  });

  it("stops after a native group lookup when the caller retires without marking a send", async () => {
    const fixture = createNativeFixture(state, "group");
    const mediaPath = state.path("attachment.pdf");
    fs.writeFileSync(mediaPath, "%PDF-1.4\nsynthetic attachment");
    const caller = new AbortController();
    const retired = new Error("caller retired during group lookup");
    const onPlatformSendDispatch = vi.fn(async () => {});
    const sending = observeSend(
      sendMessageIMessage("chat_id:42", "", {
        ...fixture.options,
        mediaUrl: mediaPath,
        mediaLocalRoots: [state.root],
        assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
        onPlatformSendDispatch,
      }),
    );
    try {
      await vi.waitFor(
        () =>
          expect(fixture.readRecords()).toEqual([
            { kind: "cli", args: ["group", "--chat-id", "42", "--db", fixture.dbPath, "--json"] },
          ]),
        { timeout: 10_000, interval: 10 },
      );
      expect(onPlatformSendDispatch).not.toHaveBeenCalled();
      caller.abort(retired);
      fixture.release();

      await expect(sending).resolves.toEqual({ error: retired });
      expect(fixture.readRecords()).toHaveLength(1);
      expect(fixture.readRequests()).toEqual([]);
      expect(onPlatformSendDispatch).not.toHaveBeenCalled();
    } finally {
      fixture.release();
      await sending;
    }
  });

  it.each(["active", "retired"] as const)(
    "keeps the %s caller decision through a native unsupported-thread response",
    async (lifetime) => {
      const fixture = createNativeFixture(state, "thread");
      await rememberIMessageReplyCache({
        accountId: "work",
        messageId: "bound-reply-guid",
        chatId: 42,
        timestamp: Date.now(),
      });
      const caller = new AbortController();
      const retired = new Error("caller retired while threaded send was pending");
      const onPlatformSendDispatch = vi.fn(async () => {});
      const sending = observeSend(
        sendMessageIMessage("chat_id:42", "threaded reply", {
          ...fixture.options,
          conversationReadOrigin: "delegated",
          replyToId: "bound-reply-guid",
          assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
          onPlatformSendDispatch,
        }),
      );
      try {
        await vi.waitFor(
          () =>
            expect(fixture.readRequests()).toMatchObject([
              { method: "send", params: { chat_id: 42, reply_to: "bound-reply-guid" } },
            ]),
          { timeout: 10_000, interval: 10 },
        );
        if (lifetime === "retired") {
          caller.abort(retired);
        }
        fixture.release();

        if (lifetime === "retired") {
          await expect(sending).resolves.toEqual({ error: retired });
          expect(fixture.readRequests()).toHaveLength(1);
          expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
        } else {
          await expect(sending).resolves.toMatchObject({
            value: {
              messageId: "p:0/native-send",
              receipt: { platformMessageIds: ["p:0/native-send"] },
            },
          });
          const requests = fixture.readRequests();
          expect(requests).toHaveLength(2);
          expect(requests[1]).toMatchObject({
            method: "send",
            params: { chat_id: 42, text: "threaded reply" },
          });
          expect(requests[1]?.params).not.toHaveProperty("reply_to");
          expect(onPlatformSendDispatch).toHaveBeenCalledTimes(2);
        }
      } finally {
        fixture.release();
        await sending;
      }
    },
  );

  it("settles submitted success after caller A retires while caller B shares its real RPC client", async () => {
    const fixture = createNativeFixture(state, "accepted");
    const client = await createIMessageRpcClient({
      cliPath: fixture.cliPath,
      dbPath: fixture.dbPath,
    });
    const callerA = new AbortController();
    const callerB = new AbortController();
    const dispatchA = vi.fn(async () => {});
    const dispatchB = vi.fn(async () => {});
    const sendingA = observeSend(
      sendMessageIMessage("chat_id:42", "caller A", {
        ...fixture.options,
        client,
        assertDirectAdapterHandoff: () => callerA.signal.throwIfAborted(),
        onPlatformSendDispatch: dispatchA,
      }),
    );
    let sendingB: ReturnType<typeof observeSend> | undefined;
    try {
      await vi.waitFor(
        () =>
          expect(fixture.readRequests()).toMatchObject([
            { method: "send", params: { text: "caller A", chat_id: 42 } },
          ]),
        { timeout: 10_000, interval: 10 },
      );
      callerA.abort(new Error("caller A retired after submission"));
      sendingB = observeSend(
        sendMessageIMessage("chat_id:42", "caller B", {
          ...fixture.options,
          client,
          assertDirectAdapterHandoff: () => callerB.signal.throwIfAborted(),
          onPlatformSendDispatch: dispatchB,
        }),
      );
      await expect(sendingB).resolves.toMatchObject({
        value: { messageId: "p:0/caller-b", receipt: { platformMessageIds: ["p:0/caller-b"] } },
      });
      expect(fixture.readRequests().map((request) => request.params.text)).toEqual([
        "caller A",
        "caller B",
      ]);
      fixture.release();
      await expect(sendingA).resolves.toMatchObject({
        value: { messageId: "p:0/caller-a", receipt: { platformMessageIds: ["p:0/caller-a"] } },
      });

      // A completed borrower cannot close the shared transport used by the next send.
      await expect(
        sendMessageIMessage("chat_id:42", "caller B after A", {
          ...fixture.options,
          client,
          assertDirectAdapterHandoff: () => callerB.signal.throwIfAborted(),
          onPlatformSendDispatch: dispatchB,
        }),
      ).resolves.toMatchObject({ messageId: "p:0/native-send" });
      expect(fixture.readRequests().map((request) => request.params.text)).toEqual([
        "caller A",
        "caller B",
        "caller B after A",
      ]);
      expect(dispatchA).toHaveBeenCalledOnce();
      expect(dispatchB).toHaveBeenCalledTimes(2);
    } finally {
      fixture.release();
      await sendingA;
      await sendingB;
      await client.stop();
    }
  });

  it("rechecks authority after awaited real client creation before writing an RPC request", async () => {
    const fixture = createNativeFixture(state, "immediate");
    const created = createDeferred<IMessageRpcClient>();
    const releaseCreation = createDeferred<void>();
    const caller = new AbortController();
    const retired = new Error("caller retired during client creation");
    const onPlatformSendDispatch = vi.fn(async () => {});
    let client: IMessageRpcClient | undefined;
    const sending = observeSend(
      sendMessageIMessage("chat_id:42", "client creation", {
        ...fixture.options,
        createClient: async (options) => {
          const createdClient = await createIMessageRpcClient(options);
          client = createdClient;
          created.resolve(createdClient);
          await releaseCreation.promise;
          return createdClient;
        },
        assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
        onPlatformSendDispatch,
      }),
    );
    try {
      await Promise.race([
        created.promise,
        sending.then((outcome) => {
          throw new Error("send settled before RPC client creation", { cause: outcome });
        }),
      ]);
      caller.abort(retired);
      releaseCreation.resolve();

      await expect(sending).resolves.toEqual({ error: retired });
      expect(fixture.readRecords()).toEqual([]);
      expect(onPlatformSendDispatch).not.toHaveBeenCalled();
    } finally {
      releaseCreation.resolve();
      await sending;
      await client?.stop();
    }
  });
});
