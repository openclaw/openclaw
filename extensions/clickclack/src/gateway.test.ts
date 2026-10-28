import { EventEmitter } from "node:events";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/native-command-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayContext, type GatewayContext } from "./gateway.test-support.js";

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

function waitForState<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { interval: 1 });
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

let socket: FakeSocket;
let abort: AbortController;
let ctx: GatewayContext;
let run: Promise<void> | undefined;

async function startGateway() {
  run = startClickClackGatewayAccount(ctx);
  await waitForState(() => expect(client.websocket).toHaveBeenCalledTimes(1));
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
  expect(client.setBotCommands).toHaveBeenCalledTimes(1);
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
) {
  const event = createBacklogEvent(index, "message.created");
  targetSocket.emit(
    "message",
    Buffer.from(JSON.stringify({ ...event, payload: { ...event.payload, ...payload } })),
  );
}

describe("ClickClack gateway", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    socket = new FakeSocket();
    client.websocket.mockReturnValue(socket);
    abort = new AbortController();
    ctx = createGatewayContext(abort.signal, {
      apiBaseUrl: "http://127.0.0.1:8484",
      reconnectMs: 1,
    });
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
    const longDescription = "\u{1F642}".repeat(101);
    const commands = await publishNativeCommands([
      nativeCommand("Deploy-Now", {
        description: `  ${longDescription}  `,
        acceptsArgs: true,
        args: [
          { name: "target", description: "Target", type: "string", required: true },
          { name: "message", description: "Message", type: "string" },
        ],
      }),
      nativeCommand("deploy-now", { description: "Duplicate loses" }),
      nativeCommand("shortcut", { isAlias: true }),
      nativeCommand("bad name"),
      nativeCommand("also/bad"),
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
    ]);

    expect(mocks.listNativeCommandSpecsForConfig).toHaveBeenCalledWith(ctx.cfg, {
      provider: "clickclack",
    });
    expect(commands).toHaveLength(4);
    expect(commands[0]).toEqual({
      command: "deploy-now",
      description: expect.any(String),
      args_hint: "<target> [message]",
    });
    expect(Array.from(commands[0]?.description ?? "")).toHaveLength(100);
    expect(commands[1]).toEqual({
      command: "status",
      description: "status",
      args_hint: "[args]",
    });
    expect(commands[2]).toEqual({
      command: "noargs",
      description: "Run noargs",
      args_hint: "",
    });
    expect(Array.from(commands[3]?.args_hint ?? "")).toHaveLength(100);
    expect(ctx.log?.warn).toHaveBeenCalledTimes(1);
    expect(ctx.log?.warn).toHaveBeenCalledWith(
      'ClickClack command menu skipped invalid native command names: "bad name", "also/bad"',
    );
  });

  it("keeps the first 100 unique normalized commands", async () => {
    const specs = Array.from({ length: 101 }, (_, index) => nativeCommand(`command${index}`));

    const commands = await publishNativeCommands(specs);

    expect(commands).toHaveLength(100);
    expect(commands[0]?.command).toBe("command0");
    expect(commands[99]?.command).toBe("command99");
  });

  it("returns an empty overwrite for an empty native catalog", async () => {
    await expect(publishNativeCommands([])).resolves.toEqual([]);
  });

  it("publishes ready only after the realtime socket opens", async () => {
    await startGateway();
    expect(ctx.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));

    socket.emit("open");
    expect(ctx.setStatus).toHaveBeenCalledWith({
      accountId: "default",
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
      "workspace command permission rejection",
      new ClickClackHttpError(403, "forbidden", new Headers()),
      "warn",
      "[default] ClickClack command menu sync skipped: ClickClack 403: forbidden; verify token/workspace command permissions or set commandMenu: false if menus are not needed",
    ],
    [
      "older server",
      new ClickClackHttpError(404, "not found", new Headers()),
      "debug",
      "[default] ClickClack command menu sync skipped: server does not support /api/bots/self/commands",
    ],
    [
      "network failure",
      new Error("network unavailable"),
      "warn",
      "[default] ClickClack command menu sync failed: network unavailable",
    ],
  ] as const)("continues startup after %s", async (_label, error, level, message) => {
    client.setBotCommands.mockRejectedValueOnce(error);
    await startGateway();
    expect(ctx.log?.[level]).toHaveBeenCalledWith(message);
    expect(ctx.setStatus).toHaveBeenCalledWith({
      accountId: "default",
      running: true,
      lifecycle: "starting",
      configured: true,
      enabled: true,
      baseUrl: "https://clickclack.example",
    });
  });

  it("drains and processes every reconnect page before reopening realtime", async () => {
    const [firstSocket] = reconnectSockets();
    const firstReconnectPage = Array.from({ length: 500 }, (_, index) =>
      createBacklogEvent(index + 1),
    );
    client.eventPage
      .mockResolvedValueOnce({ events: [], tailCursor: "" })
      .mockResolvedValueOnce({ events: firstReconnectPage })
      .mockResolvedValueOnce({ events: [createBacklogEvent(501, "message.created")] });
    await startGateway();
    firstSocket.emit("close");
    await waitForState(() => expect(client.websocket).toHaveBeenCalledTimes(2));

    expectBacklogPage(2, "");
    expectBacklogPage(3, "cursor-500");
    expectBacklogPage(4, "cursor-501");
    expect(inbound).toHaveBeenCalledTimes(1);
    expect(client.websocket).toHaveBeenLastCalledWith("workspace-1", "cursor-501");
  });

  it("skips malformed frames and dispatches with the scoped context builder", async () => {
    const { channel } = createPluginRuntimeMock();
    ctx.channelRuntime = channel;
    let runError: unknown;
    run = startClickClackGatewayAccount(ctx).catch((error: unknown) => {
      runError = error;
    });

    await waitForState(() => expect(client.websocket).toHaveBeenCalledTimes(1));

    socket.emit("message", Buffer.from("{not json"));
    await nextTurn();
    expect(runError).toBeUndefined();
    expect(ctx.log?.warn).toHaveBeenCalledWith(
      "[default] skipped malformed ClickClack websocket event",
    );

    emitMessageEvent(socket, 1);

    await waitForState(() => expect(inbound).toHaveBeenCalledTimes(1));
    expect(inbound.mock.calls[0]?.[0].buildContext).toBe(channel.inbound.buildContext);
    expect(inbound.mock.calls[0]?.[0].access).toEqual({
      shouldDispatch: true,
      commandAuthorized: true,
    });
    expect(mocks.createClickClackClient).toHaveBeenCalledTimes(1);
    expect(inbound.mock.calls[0]?.[0]).not.toHaveProperty("correlationId");
    abort.abort();
    await run;
    expect(runError).toBeUndefined();
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
    await waitForState(() => expect(client.websocket).toHaveBeenCalledTimes(2));

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
    ["dispatch", new Error("dispatch failed"), 2, 3, "dispatch failed"],
    ["message", new Error("message fetch failed"), 1, 1, "message fetch failed"],
    [
      "access",
      { code: "ECONNRESET", retryable: true },
      1,
      1,
      '{"code":"ECONNRESET","retryable":true}',
    ],
  ] as const)(
    "replays %s failures before committing the cursor",
    async (source, error, eventCount, callCount, warning) => {
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
      await waitForState(() => expect(client.websocket).toHaveBeenCalledTimes(2));

      expect(inbound).toHaveBeenCalledTimes(callCount);
      if (source === "message") {
        expect(client.message).toHaveBeenCalledTimes(2);
      }
      expect(firstSocket.close).toHaveBeenCalledOnce();
      expectBacklogPage(2, "");
      expect(client.websocket).toHaveBeenLastCalledWith("workspace-1", `cursor-${eventCount}`);
      expect(ctx.log?.warn).toHaveBeenCalledWith(
        `[default] ClickClack event processing failed; reconnecting: ${warning}`,
      );
    },
  );

  it("does not serialize unrelated gateway streams", async () => {
    const [slowSocket, fastSocket] = reconnectSockets();
    const paused = pauseFirstDispatch();
    const slowAbort = new AbortController();
    const fastAbort = new AbortController();
    const slowRun = startClickClackGatewayAccount(createGatewayContext(slowAbort.signal));
    const fastRun = startClickClackGatewayAccount(createGatewayContext(fastAbort.signal));

    await waitForState(() => expect(client.websocket).toHaveBeenCalledTimes(2));

    emitMessageEvent(slowSocket, 1);
    await paused.started;
    emitMessageEvent(fastSocket, 2);

    await waitForState(() => expect(inbound).toHaveBeenCalledTimes(2));

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

    await waitForState(() => expect(resolveAccess).toHaveBeenCalledTimes(1));
    expect(resolveAccess.mock.calls[0]?.[0].account).toMatchObject({
      botHandle: "bot",
      botUserId: "bot-user",
    });
    expect(inbound).not.toHaveBeenCalled();
    expect(ctx.log?.info).toHaveBeenCalledWith(
      expect.stringContaining("skipped ClickClack message before agent dispatch"),
    );
  });

  it("passes other bot-authored messages to ClickClack access policy", async () => {
    mocks.client.message.mockResolvedValueOnce({
      id: "msg-1",
      workspace_id: "workspace-1",
      channel_id: "chan-1",
      author_id: "other-bot",
      thread_root_id: "msg-1",
      body: "coordinate",
      body_format: "markdown",
      created_at: "2026-01-01T00:00:00.000Z",
      author: {
        id: "other-bot",
        kind: "bot",
        display_name: "Other bot",
        handle: "other-bot",
        avatar_url: "",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    });
    await startGateway();
    emitMessageEvent(socket, 1, { author_id: "other-bot" });

    await waitForState(() => expect(inbound).toHaveBeenCalledTimes(1));
    expect(resolveAccess).toHaveBeenCalledTimes(1);
    abort.abort();
    await run;
  });

  it("carries validated event correlation through the authoritative fetch and inbound turn", async () => {
    await startGateway();

    emitMessageEvent(socket, 1, { correlation_id: " fakeco.case_1 " });

    await vi.waitFor(() => expect(inbound).toHaveBeenCalledTimes(1));
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

  it("reconnects after ClickClack websocket errors", async () => {
    const [firstSocket] = reconnectSockets();
    firstSocket.emitErrorOnClose = true;
    await startGateway();

    firstSocket.emit("error", new Error("gateway dropped"));

    await waitForState(() => expect(client.websocket).toHaveBeenCalledTimes(2));
    expect(ctx.log?.warn).toHaveBeenCalledWith(
      "[default] ClickClack websocket error; reconnecting: gateway dropped",
    );
    expect(ctx.setStatus).toHaveBeenCalledWith({
      accountId: "default",
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
      expect(ctx.setStatus).toHaveBeenCalledWith({
        accountId: "default",
        connected: false,
        lifecycle: "recovering",
      });

      abort.abort();
      await run;

      expect(vi.getTimerCount()).toBe(0);
      expect(client.websocket).toHaveBeenCalledTimes(1);
      expect(ctx.setStatus).toHaveBeenLastCalledWith({
        accountId: "default",
        running: false,
        connected: false,
        lifecycle: "stopped",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
