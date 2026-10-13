import fs from "node:fs";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  withinTest,
  type FixtureReceiptChannel,
} from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IMessageRpcClient } from "./client.js";
import { loadFreshIMessageReplyCacheForTest } from "./test-support/runtime.js";

const effectGate = vi.hoisted(() => ({ prepare: undefined as (() => Promise<void>) | undefined }));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  return {
    ...actual,
    captureEffectAuthority: () => {
      const authority = actual.captureEffectAuthority();
      const prepare = effectGate.prepare;
      return prepare
        ? {
            ...authority,
            initiate: async <T>(effect: () => T | Promise<T>) => {
              await prepare();
              return authority.initiate(effect);
            },
          }
        : authority;
    },
  };
});

afterEach(() => {
  effectGate.prepare = undefined;
});

type SendMessage = typeof import("./send.js").sendMessageIMessage;
type NativeRpcRequest = {
  id: number;
  method: string;
  params: Record<string, unknown>;
};
type NativeRecord = { kind: "cli"; args: string[] } | { kind: "rpc"; request: NativeRpcRequest };
type NativeMode = "group" | "thread" | "accepted" | "immediate";

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

function createNativeFixture(state: OpenClawTestState, mode: NativeMode) {
  const cliPath = state.path("synthetic-imsg.mjs");
  const dbPath = state.path("unused-synthetic-chat.db");
  const logPath = state.path("native-requests.jsonl");
  const releasePath = state.path("release-native-response");
  fs.writeFileSync(logPath, "");
  fs.writeFileSync(
    cliPath,
    [
      "#!" + process.execPath,
      'import fs from "node:fs";',
      'import readline from "node:readline";',
      'import { setTimeout as delay } from "node:timers/promises";',
      fixtureReceiptClientSource(receipts.endpoint),
      "const mode = " + JSON.stringify(mode) + ";",
      "const logPath = " + JSON.stringify(logPath) + ";",
      "const releasePath = " + JSON.stringify(releasePath) + ";",
      "const args = process.argv.slice(2);",
      "const record = (value) => {",
      '  fs.appendFileSync(logPath, JSON.stringify(value) + "\\n");',
      "  sendReceipt(logPath, value.kind);",
      "};",
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
    waitForRequest: (operation: PromiseLike<unknown>, signal: AbortSignal) =>
      withinTest(
        Promise.race([
          receipts.waitFor(logPath, mode === "group" ? "cli" : "rpc"),
          // The durable record precedes every reply; its receipt travels on a separate pipe.
          Promise.resolve(operation).then(() => {
            if (readRecords().length === 0) {
              throw new Error("send settled before the native request boundary");
            }
          }),
        ]),
        signal,
      ),
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
  let releases: Array<() => void>;
  let sends: ReturnType<typeof observeSend>[];
  let clients: IMessageRpcClient[];

  beforeEach(async () => {
    releases = [];
    sends = [];
    clients = [];
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
    for (const release of releases) {
      release();
    }
    await Promise.all(sends);
    await Promise.all(clients.map((client) => client.stop()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await state.cleanup();
  });

  function handoff(mode: NativeMode) {
    const fixture = createNativeFixture(state, mode);
    releases.push(fixture.release);
    const caller = new AbortController();
    const retired = new Error("caller retired");
    const dispatch = vi.fn(async () => {});
    return {
      ...fixture,
      dispatch,
      retired,
      retire: () => caller.abort(retired),
      send(text: string, options: Partial<Parameters<SendMessage>[2]> = {}) {
        const sending = observeSend(
          sendMessageIMessage("chat_id:42", text, {
            ...fixture.options,
            assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
            onPlatformSendDispatch: dispatch,
            ...options,
          }),
        );
        sends.push(sending);
        return sending;
      },
    };
  }

  function expectReceipt(sending: ReturnType<typeof observeSend>, messageId: string) {
    return expect(sending).resolves.toMatchObject({
      value: { messageId, receipt: { platformMessageIds: [messageId] } },
    });
  }

  it("rechecks the native CLI handoff after preparing scheduled send authority", async () => {
    const fixture = handoff("immediate");
    const preparing = createDeferred<void>();
    const prepared = createDeferred<void>();
    releases.push(() => prepared.resolve());
    effectGate.prepare = async () => {
      preparing.resolve();
      await prepared.promise;
    };
    const mediaPath = state.path("attachment.pdf");
    fs.writeFileSync(mediaPath, "%PDF-1.4\nsynthetic attachment");
    const sending = fixture.send("", { mediaUrl: mediaPath, mediaLocalRoots: [state.root] });
    await Promise.race([
      preparing.promise,
      sending.then((outcome) => {
        throw new Error("CLI send bypassed authority preparation", { cause: outcome });
      }),
    ]);
    expect(fixture.readRecords()).toEqual([]);
    fixture.retire();
    prepared.resolve();
    await expect(sending).resolves.toEqual({ error: fixture.retired });
    expect(fixture.readRecords()).toEqual([]);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("stops after a native group lookup when the caller retires without marking a send", async ({
    signal,
  }) => {
    const fixture = handoff("group");
    const mediaPath = state.path("attachment.pdf");
    fs.writeFileSync(mediaPath, "%PDF-1.4\nsynthetic attachment");
    const sending = fixture.send("", { mediaUrl: mediaPath, mediaLocalRoots: [state.root] });
    await fixture.waitForRequest(sending, signal);
    expect(fixture.readRecords()).toEqual([
      { kind: "cli", args: ["group", "--chat-id", "42", "--db", fixture.dbPath, "--json"] },
    ]);
    expect(fixture.dispatch).not.toHaveBeenCalled();
    fixture.retire();
    fixture.release();
    await expect(sending).resolves.toEqual({ error: fixture.retired });
    expect(fixture.readRecords()).toHaveLength(1);
    expect(fixture.readRequests()).toEqual([]);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it.for(["active", "retired"] as const)(
    "keeps the %s caller decision through a native unsupported-thread response",
    async (lifetime, { signal }) => {
      const fixture = handoff("thread");
      await rememberIMessageReplyCache({
        accountId: "work",
        messageId: "bound-reply-guid",
        chatId: 42,
        timestamp: Date.now(),
      });
      const sending = fixture.send("threaded reply", {
        conversationReadOrigin: "delegated",
        replyToId: "bound-reply-guid",
      });
      await fixture.waitForRequest(sending, signal);
      expect(fixture.readRequests()).toMatchObject([
        { method: "send", params: { chat_id: 42, reply_to: "bound-reply-guid" } },
      ]);
      if (lifetime === "retired") {
        fixture.retire();
      }
      fixture.release();
      if (lifetime === "retired") {
        await expect(sending).resolves.toEqual({ error: fixture.retired });
        expect(fixture.readRequests()).toHaveLength(1);
        expect(fixture.dispatch).toHaveBeenCalledOnce();
      } else {
        await expectReceipt(sending, "p:0/native-send");
        const requests = fixture.readRequests();
        expect(requests).toHaveLength(2);
        expect(requests[1]).toMatchObject({
          method: "send",
          params: { chat_id: 42, text: "threaded reply" },
        });
        expect(requests[1]?.params).not.toHaveProperty("reply_to");
        expect(fixture.dispatch).toHaveBeenCalledTimes(2);
      }
    },
  );

  it("settles submitted success after caller A retires while caller B shares its real RPC client", async ({
    signal,
  }) => {
    const fixture = handoff("accepted");
    const client = await createIMessageRpcClient({
      cliPath: fixture.cliPath,
      dbPath: fixture.dbPath,
    });
    clients.push(client);
    const callerB = new AbortController();
    const dispatchB = vi.fn(async () => {});
    const optionsB = {
      client,
      assertDirectAdapterHandoff: () => callerB.signal.throwIfAborted(),
      onPlatformSendDispatch: dispatchB,
    };
    const sendingA = fixture.send("caller A", { client });
    await fixture.waitForRequest(sendingA, signal);
    expect(fixture.readRequests()).toMatchObject([
      { method: "send", params: { text: "caller A", chat_id: 42 } },
    ]);
    fixture.retire();
    await expectReceipt(fixture.send("caller B", optionsB), "p:0/caller-b");
    expect(fixture.readRequests().map((request) => request.params.text)).toEqual([
      "caller A",
      "caller B",
    ]);
    fixture.release();
    await expectReceipt(sendingA, "p:0/caller-a");
    // A completed borrower cannot close the shared transport used by the next send.
    await expectReceipt(fixture.send("caller B after A", optionsB), "p:0/native-send");
    expect(fixture.readRequests().map((request) => request.params.text)).toEqual([
      "caller A",
      "caller B",
      "caller B after A",
    ]);
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect(dispatchB).toHaveBeenCalledTimes(2);
  });

  it("rechecks authority after awaited real client creation before writing an RPC request", async () => {
    const fixture = handoff("immediate");
    const created = createDeferred<IMessageRpcClient>();
    const releaseCreation = createDeferred<void>();
    releases.push(() => releaseCreation.resolve());
    const sending = fixture.send("client creation", {
      createClient: async (options) => {
        const client = await createIMessageRpcClient(options);
        clients.push(client);
        created.resolve(client);
        await releaseCreation.promise;
        return client;
      },
    });
    await Promise.race([
      created.promise,
      sending.then((outcome) => {
        throw new Error("send settled before RPC client creation", { cause: outcome });
      }),
    ]);
    fixture.retire();
    releaseCreation.resolve();
    await expect(sending).resolves.toEqual({ error: fixture.retired });
    expect(fixture.readRecords()).toEqual([]);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
});
