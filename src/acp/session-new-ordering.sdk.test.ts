/** Acceptance at the installed stable ACP SDK's actual NDJSON boundary. */
import {
  AgentSideConnection,
  ndJsonStream,
  type AnyMessage,
  type JsonRpcId,
} from "@agentclientprotocol/sdk";
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { AcpSessionNewOrdering } from "./session-new-ordering.js";

const cleanups: Array<() => Promise<void>> = [];
const FAST_POLL = { interval: 1 } as const;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
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
        await conn.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "session_info_update", title: "snapshot" },
        });
        if (sessionId === "slow") {
          await slow.promise;
        }
        return { sessionId };
      },
      async loadSession(params) {
        entered.push(`load:${params.sessionId}`);
        store.createSession({ ...params, sessionKey: params.sessionId });
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "session_info_update", title: "loaded" },
        });
        return {};
      },
      async resumeSession(params) {
        entered.push(`resume:${params.sessionId}`);
        store.createSession({ ...params, sessionKey: params.sessionId });
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "session_info_update", title: "resumed" },
        });
        return {};
      },
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
  cleanups.push(async () => {
    slow.resolve();
    if (!inputCancelled) {
      input.close();
    }
    await connection.closed.catch(() => {});
    outputAbort.abort();
    await outputDone.catch(() => {});
    store.dispose();
  });
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

describe("ACP SDK NDJSON ordering", () => {
  it("streams create/prompt/load/resume with empty and null IDs while a creation is pending", async () => {
    const wire = createWireHarness();
    wire.send(create(90, "slow"));
    await expect.poll(() => wire.entered, FAST_POLL).toContain("slow");
    wire.send(create(1, "chatty"));
    await wire.waitResponse(1);
    wire.send(request(2, "session/prompt", { sessionId: "chatty", prompt: [] }));
    await wire.waitResponse(2);
    wire.send(request("", "session/load", { sessionId: "loaded", cwd: "/tmp", mcpServers: [] }));
    await wire.waitResponse("");
    wire.send(
      request(null, "session/resume", { sessionId: "resumed", cwd: "/tmp", mcpServers: [] }),
    );
    await wire.waitResponse(null);
    expect(wire.responseIndex(90)).toBe(-1);
    expect(wire.updateIndex("chatty")).toBeGreaterThan(wire.responseIndex(1));
    const text = wire.frames.findIndex(
      (frame) => "method" in frame && JSON.stringify(frame).includes('"answer"'),
    );
    expect(text).toBeGreaterThan(wire.responseIndex(1));
    expect(text).toBeLessThan(wire.responseIndex(2));
    expect(wire.updateIndex("loaded")).toBeGreaterThanOrEqual(0);
    expect(wire.updateIndex("loaded")).toBeLessThan(wire.responseIndex(""));
    expect(wire.updateIndex("resumed")).toBeGreaterThanOrEqual(0);
    expect(wire.updateIndex("resumed")).toBeLessThan(wire.responseIndex(null));
    wire.slow.resolve();
    await wire.waitResponse(90);
    await expect
      .poll(() => wire.updateIndex("slow"), FAST_POLL)
      .toBeGreaterThan(wire.responseIndex(90));
  });

  it.each([
    {
      failure: "missing protocol version",
      message: { ...create(41, "invalid"), jsonrpc: undefined },
    },
    {
      failure: "invalid parameters",
      message: request(null, "session/new", { cwd: 1, mcpServers: [] }),
    },
    ...["session/load", "session/resume"].map((method) => ({
      failure: `malformed ${method}`,
      message: {
        ...request(41, method, { sessionId: "slow", cwd: "/tmp", mcpServers: [] }),
        jsonrpc: "1.0",
      },
    })),
  ])("retires rejected session correlations after $failure", async ({ message }) => {
    const wire = createWireHarness();
    wire.send(message);
    await wire.waitResponse(null);
    expect(wire.entered).toEqual([]);
    await wire.connection.sessionUpdate({
      sessionId: "unowned",
      update: { sessionUpdate: "session_info_update", title: "after rejection" },
    });
    wire.send(request(42, "initialize", { protocolVersion: 1, clientCapabilities: {} }));
    await wire.waitResponse(42);
    expect(wire.updateIndex("unowned")).toBeGreaterThanOrEqual(0);
    expect(wire.updateIndex("unowned")).toBeLessThan(wire.responseIndex(42));
    wire.send(create("", "slow"));
    await expect.poll(() => wire.entered, FAST_POLL).toContain("slow");
    wire.slow.resolve();
    const response = await wire.waitResponse("");
    await expect.poll(() => wire.updateIndex("slow"), FAST_POLL).toBeGreaterThan(response);
    expect(wire.entered).toEqual(["slow"]);
    expect(wire.updateIndex("unowned")).toBeGreaterThanOrEqual(0);
  });

  it("does not settle a null-ID creation on an uncorrelated protocol error", async () => {
    const wire = createWireHarness();
    wire.send(create(null, "slow"));
    await expect.poll(() => wire.entered, FAST_POLL).toContain("slow");
    wire.send({ ...create(41, "invalid"), jsonrpc: "1.0" });
    await wire.waitResponse(null);
    wire.send(request(42, "initialize", { protocolVersion: 1, clientCapabilities: {} }));
    await wire.waitResponse(42);
    expect(wire.updateIndex("slow")).toBe(-1);
    wire.slow.resolve();
    await expect
      .poll(() => wire.frames.some((frame) => "result" in frame && frame.id === null), FAST_POLL)
      .toBe(true);
    await expect.poll(() => wire.updateIndex("slow"), FAST_POLL).toBeGreaterThan(2);
  });

  it("forgets recognition when the actual session store evicts an idle session", async () => {
    const wire = createWireHarness(1);
    wire.send(create(1, "evicted"));
    await wire.waitResponse(1);
    wire.send(create(2, "slow"));
    await expect.poll(() => wire.entered, FAST_POLL).toContain("slow");
    expect(wire.store.hasSession("evicted")).toBe(false);
    const before = wire.frames.length;
    await wire.connection.sessionUpdate({
      sessionId: "evicted",
      update: { sessionUpdate: "session_info_update", title: "late" },
    });
    wire.send(request(3, "initialize", { protocolVersion: 1, clientCapabilities: {} }));
    await wire.waitResponse(3);
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
});
