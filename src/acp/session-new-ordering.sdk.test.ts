import {
  AgentSideConnection,
  ndJsonStream,
  type AnyMessage,
  type JsonRpcId,
} from "@agentclientprotocol/sdk";
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { AcpSessionNewOrdering } from "./session-new-ordering.js";

let cleanup: (() => Promise<void>) | undefined;
const FAST_POLL = { interval: 1 } as const;
afterEach(async () => {
  const dispose = cleanup;
  cleanup = undefined;
  await dispose?.();
});

function createWireHarness(maxSessions = 10) {
  const ordering = new AcpSessionNewOrdering();
  const store = createInMemorySessionStore({
    maxSessions,
    onSessionRemoved: (sessionId) => ordering.forget(sessionId),
  });
  const frames: AnyMessage[] = [];
  const entered: string[] = [];
  const slow = createDeferred();
  const sessionInfo = (sessionId: string, title: string) => ({
    sessionId,
    update: { sessionUpdate: "session_info_update" as const, title },
  });
  async function restoreSession(
    conn: AgentSideConnection,
    params: { sessionId: string; cwd: string },
    method: "load" | "resume",
  ) {
    entered.push(`${method}:${params.sessionId}`);
    store.createSession({ ...params, sessionKey: params.sessionId });
    await conn.sessionUpdate(
      sessionInfo(params.sessionId, method === "load" ? "loaded" : "resumed"),
    );
    return {};
  }
  let input!: ReadableStreamDefaultController<Uint8Array>;
  let outputFailure: Error | undefined;
  let inputCancelled = false;
  const stream = ndJsonStream(
    new WritableStream<Uint8Array>({
      write(bytes) {
        if (outputFailure) {
          throw outputFailure;
        }
        frames.push(JSON.parse(new TextDecoder().decode(bytes)) as AnyMessage);
      },
    }),
    new ReadableStream<Uint8Array>({
      start(controller) {
        input = controller;
      },
      cancel() {
        inputCancelled = true;
      },
    }),
  );
  const ordered = new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller) {
      ordering.transformOutbound(message, controller);
    },
  });
  const outputAbort = new AbortController();
  const outputDone = ordered.readable.pipeTo(stream.writable, { signal: outputAbort.signal });
  void outputDone.catch(() => {});
  const connection = new AgentSideConnection(
    (conn) => ({
      async initialize() {
        return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      },
      async authenticate() {},
      async newSession(params) {
        const sessionId = params.cwd.slice(1);
        entered.push(sessionId);
        store.createSession({ sessionId, sessionKey: sessionId, cwd: params.cwd });
        await conn.sessionUpdate(sessionInfo(sessionId, "snapshot"));
        if (sessionId === "slow") {
          await slow.promise;
        }
        return { sessionId };
      },
      loadSession: (params) => restoreSession(conn, params, "load"),
      resumeSession: (params) => restoreSession(conn, params, "resume"),
      async prompt(params) {
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "answer" },
          },
        });
        return { stopReason: "end_turn" };
      },
      async cancel() {},
    }),
    {
      readable: stream.readable.pipeThrough(
        new TransformStream<AnyMessage, AnyMessage>({
          transform(message, controller) {
            ordering.observeInbound(message);
            controller.enqueue(message);
          },
        }),
      ),
      writable: ordered.writable,
    },
  );
  void connection.closed.catch(() => {});
  const send = (message: unknown) =>
    input.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  const responseIndex = (id: JsonRpcId) =>
    frames.findIndex((frame) => "id" in frame && frame.id === id && !("method" in frame));
  const waitResponse = async (id: JsonRpcId) => {
    await expect.poll(() => responseIndex(id), FAST_POLL).toBeGreaterThanOrEqual(0);
    return responseIndex(id);
  };
  const updateIndex = (sessionId: string) =>
    frames.findIndex(
      (frame) =>
        "method" in frame &&
        frame.method === "session/update" &&
        (frame.params as { sessionId?: string }).sessionId === sessionId,
    );
  const exchange = async (message: ReturnType<typeof request>) => {
    send(message);
    return waitResponse(message.id);
  };
  const beginSlow = async (id: JsonRpcId) => {
    send(create(id, "slow"));
    await expect.poll(() => entered, FAST_POLL).toContain("slow");
  };
  const expectUpdateBefore = (sessionId: string, id: JsonRpcId) => {
    expect(updateIndex(sessionId)).toBeGreaterThanOrEqual(0);
    expect(updateIndex(sessionId)).toBeLessThan(responseIndex(id));
  };
  cleanup = async () => {
    slow.resolve();
    if (!inputCancelled) {
      input.close();
    }
    await connection.closed.catch(() => {});
    outputAbort.abort();
    await outputDone.catch(() => {});
    store.dispose();
  };
  return {
    frames,
    entered,
    slow,
    store,
    connection,
    send,
    responseIndex,
    waitResponse,
    updateIndex,
    sessionInfo,
    exchange,
    beginSlow,
    expectUpdateBefore,
    failOutput: () => {
      outputFailure = new Error("stdout closed");
    },
    outputDone,
  };
}

function request(id: JsonRpcId, method: string, params: unknown) {
  return { jsonrpc: "2.0", id, method, params };
}
function create(id: JsonRpcId, sessionId: string) {
  return request(id, "session/new", { cwd: `/${sessionId}`, mcpServers: [] });
}
const initialize = (id: number) =>
  request(id, "initialize", { protocolVersion: 1, clientCapabilities: {} });
const restore = (id: JsonRpcId, method: string, sessionId: string) =>
  request(id, method, { sessionId, cwd: "/tmp", mcpServers: [] });

it("streams create/prompt/load/resume with empty and null IDs while a creation is pending", async () => {
  const wire = createWireHarness();
  await wire.beginSlow(90);
  await wire.exchange(create(1, "chatty"));
  await wire.exchange(request(2, "session/prompt", { sessionId: "chatty", prompt: [] }));
  await wire.exchange(restore("", "session/load", "loaded"));
  await wire.exchange(restore(null, "session/resume", "resumed"));
  expect(wire.responseIndex(90)).toBe(-1);
  expect(wire.updateIndex("chatty")).toBeGreaterThan(wire.responseIndex(1));
  const text = wire.frames.findIndex(
    (frame) => "method" in frame && JSON.stringify(frame).includes('"answer"'),
  );
  expect(text).toBeGreaterThan(wire.responseIndex(1));
  expect(text).toBeLessThan(wire.responseIndex(2));
  wire.expectUpdateBefore("loaded", "");
  wire.expectUpdateBefore("resumed", null);
  wire.slow.resolve();
  await wire.waitResponse(90);
  await expect
    .poll(() => wire.updateIndex("slow"), FAST_POLL)
    .toBeGreaterThan(wire.responseIndex(90));
});

it.each([
  { ...create(41, "invalid"), jsonrpc: undefined },
  request(null, "session/new", { cwd: 1, mcpServers: [] }),
  ...["session/load", "session/resume"].map((method) =>
    Object.assign(restore(41, method, "slow"), { jsonrpc: "1.0" }),
  ),
])("retires rejected session correlations for %j", async (message) => {
  const wire = createWireHarness();
  wire.send(message);
  await wire.waitResponse(null);
  expect(wire.entered).toEqual([]);
  await wire.connection.sessionUpdate(wire.sessionInfo("unowned", "after rejection"));
  await wire.exchange(initialize(42));
  wire.expectUpdateBefore("unowned", 42);
  await wire.beginSlow("");
  wire.slow.resolve();
  const response = await wire.waitResponse("");
  await expect.poll(() => wire.updateIndex("slow"), FAST_POLL).toBeGreaterThan(response);
  expect(wire.entered).toEqual(["slow"]);
  expect(wire.updateIndex("unowned")).toBeGreaterThanOrEqual(0);
});

it("does not settle a null-ID creation on an uncorrelated protocol error", async () => {
  const wire = createWireHarness();
  await wire.beginSlow(null);
  wire.send({ ...create(41, "invalid"), jsonrpc: "1.0" });
  await wire.waitResponse(null);
  await wire.exchange(initialize(42));
  expect(wire.updateIndex("slow")).toBe(-1);
  wire.slow.resolve();
  await expect
    .poll(() => wire.frames.some((frame) => "result" in frame && frame.id === null), FAST_POLL)
    .toBe(true);
  await expect.poll(() => wire.updateIndex("slow"), FAST_POLL).toBeGreaterThan(2);
});

it("forgets recognition when the actual session store evicts an idle session", async () => {
  const wire = createWireHarness(1);
  await wire.exchange(create(1, "evicted"));
  await wire.beginSlow(2);
  expect(wire.store.hasSession("evicted")).toBe(false);
  const before = wire.frames.length;
  await wire.connection.sessionUpdate(wire.sessionInfo("evicted", "late"));
  await wire.exchange(initialize(3));
  expect(wire.frames.slice(before)).toHaveLength(1);
  wire.slow.resolve();
  await wire.waitResponse(2);
  await expect.poll(() => wire.frames.length, FAST_POLL).toBe(before + 4);
});

it("reports NDJSON output failure to the server shutdown owner", async () => {
  const wire = createWireHarness();
  wire.failOutput();
  wire.send(create(1, "broken-output"));
  await expect(wire.outputDone).rejects.toThrow("stdout closed");
  expect(wire.frames).toEqual([]);
});

it("preserves the stable SDK's rejection of NDJSON batch frames", async () => {
  const wire = createWireHarness();
  wire.send([create(1, "batched")]);
  await wire.connection.closed.catch(() => {});
  expect(wire.entered).toEqual([]);
  expect(wire.frames).toEqual([]);
});
