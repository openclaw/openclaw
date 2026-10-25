import { EventEmitter } from "node:events";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/native-command-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedClickClackAccount } from "./types.js";

type GatewayContext = ChannelGatewayContext<ResolvedClickClackAccount>;
type CommandMenuEntry = { command: string; description: string; args_hint: string };

class FakeSocket extends EventEmitter {
  emitErrorOnClose = false;

  close = vi.fn(() => {
    if (this.emitErrorOnClose) {
      this.emit("error", new Error("socket closed while connecting"));
    }
    this.emit("close");
  });
}

function expectCalls(mock: typeof client.websocket, count: number) {
  return vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(count), { interval: 1 });
}

const mocks = vi.hoisted(() => ({
  createClickClackClient: vi.fn(),
  listNativeCommandSpecsForConfig: vi.fn(),
  client: {
    me: vi.fn(),
    eventPage: vi.fn(),
    websocket: vi.fn(),
    message: vi.fn(),
    setBotCommands: vi.fn<(commands: CommandMenuEntry[]) => Promise<unknown[]>>(),
  },
  inbound: vi.fn(),
  resolveAccess: vi.fn(),
  resolveWorkspaceId: vi.fn(),
}));

// mock-isolation: Gateway tests supply access decisions independently of channel policy.
vi.mock("./access.js", () => ({
  resolveClickClackInboundAccess: mocks.resolveAccess,
}));

vi.mock("./http-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./http-client.js")>();
  return { ...actual, createClickClackClient: mocks.createClickClackClient };
});

// mock-isolation: Gateway tests observe dispatch without starting agent turns.
vi.mock("./inbound.js", () => ({ handleClickClackInbound: mocks.inbound }));

vi.mock("openclaw/plugin-sdk/native-command-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/native-command-registry")>()),
  listNativeCommandSpecsForConfig: mocks.listNativeCommandSpecsForConfig,
}));

// mock-isolation: Workspace resolution is fixed by the synthetic gateway fixture.
vi.mock("./resolve.js", () => ({ resolveWorkspaceId: mocks.resolveWorkspaceId }));

import { startClickClackGatewayAccount } from "./gateway.js";
import { ClickClackHttpError } from "./http-client.js";

const { client, inbound, resolveAccess } = mocks;

function createGatewayContext(abortSignal: AbortSignal): GatewayContext {
  return {
    cfg: {
      channels: {
        clickclack: {
          baseUrl: "https://clickclack.example",
          apiBaseUrl: "http://127.0.0.1:8484",
          token: "test-token",
          workspace: "main",
          reconnectMs: 1,
        },
      },
    } as GatewayContext["cfg"],
    accountId: "default",
    account: {} as ResolvedClickClackAccount,
    runtime: {} as GatewayContext["runtime"],
    abortSignal,
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getStatus: () => ({ accountId: "default" }) as ReturnType<GatewayContext["getStatus"]>,
    setStatus: vi.fn(),
  };
}

let socket: FakeSocket;
let abort: AbortController;
let ctx: GatewayContext;
let run: Promise<void> | undefined;

async function startGateway() {
  run = startClickClackGatewayAccount(ctx);
  await expectCalls(client.websocket, 1);
}

function expectStatus(
  patch: Omit<Parameters<GatewayContext["setStatus"]>[0], "accountId">,
  last = false,
) {
  expect(ctx.setStatus)[last ? "toHaveBeenLastCalledWith" : "toHaveBeenCalledWith"]({
    accountId: "default",
    ...patch,
  });
}

function nativeCommand(
  name: string,
  options: Partial<Omit<NativeCommandSpec, "name">> = {},
): NativeCommandSpec {
  return {
    name,
    description: options.description ?? `Run ${name}`,
    acceptsArgs: options.acceptsArgs ?? false,
    ...options,
  };
}

async function publishNativeCommands(specs: NativeCommandSpec[]): Promise<CommandMenuEntry[]> {
  mocks.listNativeCommandSpecsForConfig.mockReturnValue(specs);
  await startGateway();
  const commands = client.setBotCommands.mock.calls[0]?.[0];
  if (!commands) {
    throw new Error("Gateway startup did not publish its command menu");
  }
  return commands;
}

function nextTurn() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function reconnectSockets() {
  const firstSocket = new FakeSocket();
  const secondSocket = new FakeSocket();
  client.websocket.mockReset().mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket);
  return [firstSocket, secondSocket] as const;
}

function expectBacklogPage(call: number, afterCursor: string) {
  expect(client.eventPage).toHaveBeenNthCalledWith(call, "workspace-1", {
    afterCursor,
    limit: 500,
  });
}

function pauseFirstDispatch() {
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  inbound.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
  });
  return { started: started.promise, release: () => release.resolve() };
}

function createBacklogEvent(index: number, type = "channel.updated") {
  return {
    cursor: `cursor-${index}`,
    type,
    payload: type === "message.created" ? { message_id: "msg-1", author_id: "human-1" } : undefined,
  };
}

function emitMessageEvent(
  targetSocket: FakeSocket,
  index: number,
  payload: Record<string, unknown> = {},
  type = "message.created",
) {
  const event = createBacklogEvent(index, "message.created");
  targetSocket.emit(
    "message",
    Buffer.from(JSON.stringify({ ...event, type, payload: { ...event.payload, ...payload } })),
  );
}

describe("ClickClack gateway", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    socket = new FakeSocket();
    client.websocket.mockReturnValue(socket);
    abort = new AbortController();
    ctx = createGatewayContext(abort.signal);
    run = undefined;
    mocks.createClickClackClient.mockReturnValue(client);
    client.me.mockResolvedValue({ id: "bot-user", handle: "bot" });
    client.eventPage.mockResolvedValue({ events: [] });
    client.setBotCommands.mockResolvedValue([]);
    mocks.listNativeCommandSpecsForConfig.mockReturnValue([]);
    resolveAccess.mockResolvedValue({
      shouldDispatch: true,
      commandAuthorized: true,
    });
    mocks.resolveWorkspaceId.mockResolvedValue("workspace-1");
    client.message.mockResolvedValue({
      id: "msg-1",
      channel_id: "chan-1",
      author_id: "human-1",
    });
  });

  afterEach(async () => {
    abort.abort();
    await run;
  });

  it("maps native commands to the bounded ClickClack menu contract", async () => {
    const commands = await publishNativeCommands([
      nativeCommand("Deploy-Now", {
        description: `  ${"\u{1F642}".repeat(101)}  `,
        acceptsArgs: true,
        args: [
          { name: "target", description: "Target", type: "string", required: true },
          { name: "message", description: "Message", type: "string" },
        ],
      }),
      nativeCommand("deploy-now", { description: "Duplicate loses" }),
      nativeCommand("shortcut", { isAlias: true }),
      nativeCommand("bad name"),
      nativeCommand("status", { description: "   ", acceptsArgs: true }),
      nativeCommand("noargs"),
      nativeCommand("long-hint", {
        args: Array.from({ length: 20 }, (_, index) => ({
          name: `argument${index}`,
          description: "Argument",
          type: "string" as const,
          required: index === 0,
        })),
      }),
      ...Array.from({ length: 101 }, (_, index) => nativeCommand(`command${index}`)),
    ]);

    expect(commands.slice(0, 4)).toEqual([
      { command: "deploy-now", description: expect.any(String), args_hint: "<target> [message]" },
      { command: "status", description: "status", args_hint: "[args]" },
      { command: "noargs", description: "Run noargs", args_hint: "" },
      { command: "long-hint", description: "Run long-hint", args_hint: expect.any(String) },
    ]);
    expect(Array.from(commands[0]?.description ?? "")).toHaveLength(100);
    expect(Array.from(commands[3]?.args_hint ?? "")).toHaveLength(100);
    expect(commands).toHaveLength(100);
    expect(commands[99]?.command).toBe("command95");
    expect(ctx.log?.warn).toHaveBeenCalledWith(expect.stringContaining("bad name"));
  });

  it("returns an empty overwrite for an empty native catalog", async () => {
    await expect(publishNativeCommands([])).resolves.toEqual([]);
  });

  it("publishes ready only after the realtime socket opens", async () => {
    await startGateway();
    expect(ctx.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));

    socket.emit("open");
    expectStatus({
      running: true,
      connected: true,
      lifecycle: "ready",
      lastConnectedAt: expect.any(Number),
      lastError: null,
      terminalDisconnect: undefined,
    });
  });

  it.each([
    [
      new ClickClackHttpError(403, "forbidden", new Headers()),
      "warn",
      "skipped: ClickClack 403: forbidden; verify token/workspace command permissions or set commandMenu: false if menus are not needed",
    ],
    [
      new ClickClackHttpError(404, "not found", new Headers()),
      "debug",
      "skipped: server does not support /api/bots/self/commands",
    ],
    [new Error("network unavailable"), "warn", "failed: network unavailable"],
  ] as const)("continues startup after %s", async (error, level, message) => {
    client.setBotCommands.mockRejectedValueOnce(error);
    await startGateway();
    expect(ctx.log?.[level]).toHaveBeenCalledWith(
      `[default] ClickClack command menu sync ${message}`,
    );
    expect(ctx.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ running: true, lifecycle: "starting" }),
    );
  });

  it("drains and processes every reconnect page before reopening realtime", async () => {
    const [firstSocket] = reconnectSockets();
    client.eventPage
      .mockResolvedValueOnce({ events: [], tailCursor: "" })
      .mockResolvedValueOnce({
        events: Array.from({ length: 500 }, (_, index) => createBacklogEvent(index + 1)),
      })
      .mockResolvedValueOnce({ events: [createBacklogEvent(501, "message.created")] });
    await startGateway();
    firstSocket.emit("close");
    await expectCalls(client.websocket, 2);

    expectBacklogPage(2, "");
    expectBacklogPage(3, "cursor-500");
    expectBacklogPage(4, "cursor-501");
    expect(inbound).toHaveBeenCalledTimes(1);
    expect(client.websocket).toHaveBeenLastCalledWith("workspace-1", "cursor-501");
  });

  it("skips malformed frames and dispatches other bots with the scoped context builder", async () => {
    const { channel } = createPluginRuntimeMock();
    ctx.channelRuntime = channel;
    client.message.mockResolvedValueOnce({
      id: "msg-1",
      channel_id: "chan-1",
      author_id: "other-bot",
      author: { id: "other-bot", kind: "bot" },
    });
    await startGateway();

    socket.emit("message", Buffer.from("{not json"));
    await nextTurn();
    expect(ctx.log?.warn).toHaveBeenCalledWith(
      "[default] skipped malformed ClickClack websocket event",
    );

    emitMessageEvent(socket, 1, { author_id: "other-bot" });

    await expectCalls(inbound, 1);
    expect(inbound.mock.calls[0]?.[0]).toMatchObject({
      buildContext: channel.inbound.buildContext,
      access: { shouldDispatch: true, commandAuthorized: true },
    });
    expect(inbound.mock.calls[0]?.[0]).not.toHaveProperty("correlationId");
  });

  it("processes websocket events in order before reconnecting from their cursor", async () => {
    const [firstSocket] = reconnectSockets();
    const paused = pauseFirstDispatch();
    await startGateway();

    for (const index of [1, 2]) {
      emitMessageEvent(firstSocket, index);
    }
    firstSocket.emit("close");

    await paused.started;
    expect(inbound).toHaveBeenCalledTimes(1);
    expect(client.websocket).toHaveBeenCalledTimes(1);

    paused.release();
    await expectCalls(client.websocket, 2);

    expect(inbound).toHaveBeenCalledTimes(2);
    expectBacklogPage(client.eventPage.mock.calls.length, "cursor-2");
  });

  it.each(["dispatch", "fetch", "access"] as const)(
    "does not start queued work after shutdown during %s",
    async (step) => {
      const started = createDeferred<void>();
      const release = createDeferred<void>();
      const operation = { dispatch: inbound, fetch: client.message, access: resolveAccess }[step];
      operation.mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        return step === "fetch"
          ? { id: "msg-1", author_id: "human-1", channel_id: "chan-1" }
          : step === "access"
            ? { shouldDispatch: true, commandAuthorized: true }
            : undefined;
      });
      await startGateway();
      emitMessageEvent(socket, 1);
      if (step === "dispatch") {
        emitMessageEvent(socket, 2);
      }
      await started.promise;
      abort.abort();
      await run;
      expect(ctx.setStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ lifecycle: "stopped" }),
      );
      release.resolve();
      await nextTurn();
      expect(inbound).toHaveBeenCalledTimes(step === "dispatch" ? 1 : 0);
      if (step === "fetch") {
        expect(resolveAccess).not.toHaveBeenCalled();
      }
      if (step === "dispatch") {
        expect(client.message).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    ["dispatch", new Error("dispatch failed"), 2, 3],
    ["message", new Error("message fetch failed"), 1, 1],
    ["access", { code: "ECONNRESET", retryable: true }, 1, 1],
  ] as const)(
    "replays %s failures before committing the cursor",
    async (source, error, eventCount, callCount) => {
      const [firstSocket] = reconnectSockets();
      const events = Array.from({ length: eventCount }, (_, index) =>
        createBacklogEvent(index + 1, "message.created"),
      );
      client.eventPage
        .mockResolvedValueOnce({ events: [], tailCursor: "" })
        .mockResolvedValueOnce({ events })
        .mockResolvedValueOnce({ events: [] });
      const failingOperation = {
        dispatch: inbound,
        message: client.message,
        access: resolveAccess,
      }[source];
      failingOperation.mockRejectedValueOnce(error);
      await startGateway();
      for (let index = 1; index <= eventCount; index++) {
        emitMessageEvent(firstSocket, index);
      }
      await expectCalls(client.websocket, 2);

      expect(inbound).toHaveBeenCalledTimes(callCount);
      if (source === "message") {
        expect(client.message).toHaveBeenCalledTimes(2);
      }
      expect(firstSocket.close).toHaveBeenCalledOnce();
      expectBacklogPage(2, "");
      expect(client.websocket).toHaveBeenLastCalledWith("workspace-1", `cursor-${eventCount}`);
      expect(ctx.log?.warn).toHaveBeenCalled();
    },
  );

  it("does not serialize unrelated gateway streams", async () => {
    const [slowSocket, fastSocket] = reconnectSockets();
    const paused = pauseFirstDispatch();
    const slowAbort = new AbortController();
    const fastAbort = new AbortController();
    const slowRun = startClickClackGatewayAccount(createGatewayContext(slowAbort.signal));
    const fastRun = startClickClackGatewayAccount(createGatewayContext(fastAbort.signal));

    await expectCalls(client.websocket, 2);

    emitMessageEvent(slowSocket, 1);
    await paused.started;
    emitMessageEvent(fastSocket, 2);

    await expectCalls(inbound, 2);

    paused.release();
    slowAbort.abort();
    fastAbort.abort();
    await Promise.all([slowRun, fastRun]);
  });

  it("drops messages denied by ClickClack sender access before inbound handling", async () => {
    resolveAccess.mockResolvedValue({
      shouldDispatch: false,
      commandAuthorized: false,
      mentionFacts: {
        wasMentioned: false,
        hasAnyMention: false,
      },
    });
    await startGateway();

    emitMessageEvent(socket, 1);

    await expectCalls(resolveAccess, 1);
    expect(resolveAccess.mock.calls[0]?.[0].account).toMatchObject({
      botHandle: "bot",
      botUserId: "bot-user",
    });
    expect(inbound).not.toHaveBeenCalled();
  });

  it("carries validated event correlation through the authoritative fetch and inbound turn", async () => {
    await startGateway();

    emitMessageEvent(socket, 1, { correlation_id: "fakeco.case_1" });

    await expectCalls(inbound, 1);
    expect(mocks.createClickClackClient).toHaveBeenLastCalledWith({
      baseUrl: "http://127.0.0.1:8484",
      token: "test-token",
      correlationId: "fakeco.case_1",
    });
    expect(client.message).toHaveBeenCalledWith("msg-1");
    expect(inbound).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "fakeco.case_1" }),
    );
  });

  it.each([
    { channel_id: "chn_1", id: "msg-101", body: "reply 101", thread_seq: 101 },
    { direct_conversation_id: "dmc_1", id: "msg_dm_reply", body: "dm thread reply", thread_seq: 1 },
  ])("fetches thread reply $id directly, outside timeline windows", async (fields) => {
    const root = "direct_conversation_id" in fields ? "msg_dm_root" : "msg_root";
    const message = {
      ...fields,
      author_id: "human-1",
      thread_root_id: root,
      parent_message_id: root,
    };
    client.message.mockResolvedValueOnce(message);
    await startGateway();
    emitMessageEvent(socket, 1, { message_id: message.id }, "thread.reply_created");
    await expectCalls(inbound, 1);
    expect(client.message).toHaveBeenCalledWith(message.id);
    expect(inbound).toHaveBeenCalledWith(expect.objectContaining({ message }));
    expect(ctx.log?.warn).not.toHaveBeenCalled();
  });

  it("warns without dispatching an unreadable thread reply", async () => {
    client.message.mockRejectedValueOnce(new ClickClackHttpError(404, "not found", new Headers()));
    await startGateway();
    emitMessageEvent(socket, 1, {}, "thread.reply_created");
    await vi.waitFor(() =>
      expect(ctx.log?.warn).toHaveBeenCalledWith(
        expect.stringContaining("skipped unreadable ClickClack message before agent dispatch"),
      ),
    );
    expect(inbound).not.toHaveBeenCalled();
  });

  it("reconnects after ClickClack websocket errors", async () => {
    const [firstSocket] = reconnectSockets();
    firstSocket.emitErrorOnClose = true;
    await startGateway();

    firstSocket.emit("error", new Error("gateway dropped"));

    await expectCalls(client.websocket, 2);
    expect(ctx.log?.warn).toHaveBeenCalledWith(
      "[default] ClickClack websocket error; reconnecting: gateway dropped",
    );
    expectStatus({
      connected: false,
      lifecycle: "recovering",
      lastError: "gateway dropped",
    });
  });

  it("cancels the reconnect delay when the gateway aborts", async () => {
    vi.useFakeTimers();
    try {
      const [firstSocket] = reconnectSockets();
      run = startClickClackGatewayAccount(ctx);

      await vi.advanceTimersByTimeAsync(0);
      expect(client.websocket).toHaveBeenCalledTimes(1);

      firstSocket.emit("close");
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      expectStatus({ connected: false, lifecycle: "recovering" });

      abort.abort();
      await run;

      expect(vi.getTimerCount()).toBe(0);
      expect(client.websocket).toHaveBeenCalledTimes(1);
      expectStatus({ running: false, connected: false, lifecycle: "stopped" }, true);
    } finally {
      vi.useRealTimers();
    }
  });
});
