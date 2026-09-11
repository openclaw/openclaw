// Codex tests cover the local session source against a fake app-server daemon.
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type {
  LocalSessionRecord,
  LocalSessionSourceHost,
} from "openclaw/plugin-sdk/local-session-source";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerTransport } from "./app-server/transport.js";

type RpcMessage = { id?: number; method?: string; params?: unknown; result?: unknown };

const mocks = vi.hoisted(() => ({
  createWebSocketTransport: vi.fn(),
  runCommandBuffered: vi.fn(),
}));

vi.mock("./app-server/transport-websocket.js", () => ({
  createWebSocketTransport: mocks.createWebSocketTransport,
}));
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runCommandBuffered: mocks.runCommandBuffered,
}));

const { createCodexLocalSessionSource } = await import("./local-session-source.js");

type FakeDaemon = {
  requests: Array<{ method: string; params: unknown }>;
  clientResponses: RpcMessage[];
  handlers: Map<string, (params: unknown) => unknown>;
  notify(method: string, params: unknown): void;
  sendServerRequest(id: number, method: string, params: unknown): void;
  dropConnection(): void;
  connections: number;
};

function createFakeDaemon(): FakeDaemon {
  const daemon: FakeDaemon = {
    requests: [],
    clientResponses: [],
    handlers: new Map(),
    connections: 0,
    notify: () => {},
    sendServerRequest: () => {},
    dropConnection: () => {},
  };
  daemon.handlers.set("initialize", () => ({ userAgent: "codex/0.153.4" }));
  mocks.createWebSocketTransport.mockImplementation(() => {
    daemon.connections += 1;
    const events = new EventEmitter();
    const stdout = new PassThrough();
    const write = (message: RpcMessage) => stdout.write(`${JSON.stringify(message)}\n`);
    let pending = "";
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const message = JSON.parse(line) as RpcMessage;
          if (typeof message.method !== "string") {
            daemon.clientResponses.push(message);
            continue;
          }
          if (message.id === undefined) {
            continue;
          }
          daemon.requests.push({ method: message.method, params: message.params });
          const handler = daemon.handlers.get(message.method);
          if (!handler) {
            write({
              id: message.id,
              error: { code: -32601, message: `no handler ${message.method}` },
            } as RpcMessage);
            continue;
          }
          try {
            write({ id: message.id, result: handler(message.params) });
          } catch (error) {
            write({ id: message.id, error: { message: String(error) } } as RpcMessage);
          }
        }
        callback();
      },
    });
    daemon.notify = (method, params) => write({ method, params });
    daemon.sendServerRequest = (id, method, params) => write({ id, method, params });
    daemon.dropConnection = () => events.emit("exit", 1006, "gone");
    const transport: CodexAppServerTransport = {
      stdin,
      stdout,
      stderr: new PassThrough(),
      once: (event, listener) => events.once(event, listener),
      kill: () => events.emit("exit", 1000, "closed"),
    };
    return transport;
  });
  return daemon;
}

type CapturedHost = LocalSessionSourceHost & {
  sessions: Array<Parameters<LocalSessionSourceHost["publishSession"]>[0]>;
  records: Array<{ threadId: string; records: LocalSessionRecord[] }>;
  deltas: Array<Parameters<LocalSessionSourceHost["publishDelta"]>[0]>;
  turns: Array<Parameters<LocalSessionSourceHost["publishTurn"]>[0]>;
  inputResults: Array<Parameters<LocalSessionSourceHost["reportInput"]>[0]>;
};

function createHost(signal: AbortSignal): CapturedHost {
  const host: CapturedHost = {
    signal,
    sessions: [],
    records: [],
    deltas: [],
    turns: [],
    inputResults: [],
    publishSession: async (frame) => {
      host.sessions.push(frame);
    },
    publishRecords: async (threadId, records) => {
      host.records.push({ threadId, records });
    },
    publishDelta: async (delta) => {
      host.deltas.push(delta);
    },
    publishTurn: async (frame) => {
      host.turns.push(frame);
    },
    reportInput: async (result) => {
      host.inputResults.push(result);
    },
  };
  return host;
}

function thread(id: string, status: { type: string }, turns: unknown[] = []) {
  return {
    id,
    name: null,
    preview: `Preview of ${id}`,
    cwd: `/repo/${id}`,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
    status,
    turns,
  };
}

function turn(id: string, items: unknown[]) {
  return { id, status: "completed", items, startedAt: 1_700_000_050, completedAt: null };
}

const enrollment = {
  enrollmentId: "enr-1",
  agentId: "agent-1",
  requester: { profileId: "prof-1", displayName: "Ada" },
  audienceLabel: "team",
};

async function startSession(
  daemon: FakeDaemon,
  options: { cursors?: Record<string, number>; excludedThreadIds?: string[] } = {},
) {
  const abort = new AbortController();
  const host = createHost(abort.signal);
  const session = await createCodexLocalSessionSource().start(host, {
    enrollment,
    cursors: options.cursors ?? {},
    excludedThreadIds: new Set(options.excludedThreadIds ?? ["t-excluded"]),
    signal: abort.signal,
  });
  await vi.waitFor(() =>
    expect(daemon.requests.some((r) => r.method === "thread/loaded/list")).toBe(true),
  );
  return { abort, host, session };
}

function recordsFor(host: CapturedHost, threadId: string): LocalSessionRecord[] {
  return host.records.filter((frame) => frame.threadId === threadId).flatMap((f) => f.records);
}

describe("codex local session source", () => {
  let daemon: FakeDaemon;
  const liveHistory = [
    turn("turn-1", [
      {
        type: "userMessage",
        id: "u1",
        clientId: "client-u1",
        content: [{ type: "text", text: "hi" }],
      },
      { type: "agentMessage", id: "a1", text: "hello" },
      {
        type: "commandExecution",
        id: "c1",
        command: "ls",
        status: "completed",
        aggregatedOutput: "file.txt",
      },
    ]),
  ];

  beforeEach(() => {
    daemon = createFakeDaemon();
    daemon.handlers.set("thread/loaded/list", () => ({
      data: ["t-live", "t-excluded"],
      nextCursor: null,
    }));
    daemon.handlers.set("thread/list", () => ({
      data: [thread("t-live", { type: "active" }), thread("t-idle", { type: "notLoaded" })],
      nextCursor: null,
    }));
    daemon.handlers.set("thread/resume", (params) => {
      const { threadId } = params as { threadId: string };
      return {
        thread: thread(threadId, { type: "active" }, threadId === "t-live" ? liveHistory : []),
      };
    });
    daemon.handlers.set("thread/read", (params) => {
      const { threadId } = params as { threadId: string };
      return {
        thread: thread(threadId, { type: "notLoaded" }, [
          turn("turn-0", [
            { type: "userMessage", id: "u0", content: [{ type: "text", text: "old" }] },
            { type: "agentMessage", id: "a0", text: "older reply" },
          ]),
        ]),
      };
    });
    daemon.handlers.set("turn/start", () => ({
      turn: { id: "turn-new", status: "inProgress", items: [] },
    }));
    daemon.handlers.set("thread/queue/add", () => ({ queuedSubmission: { id: "queued-1" } }));
  });

  afterEach(() => {
    vi.useRealTimers();
    mocks.createWebSocketTransport.mockReset();
    mocks.runCommandBuffered.mockReset();
  });

  it("inventories only loaded threads and bootstraps their records", async () => {
    const { abort, host, session } = await startSession(daemon, { cursors: { "t-idle": 1 } });
    await vi.waitFor(() => expect(host.records.length).toBe(1));

    const initialize = daemon.requests.find((r) => r.method === "initialize")?.params as {
      clientInfo: { name: string };
      capabilities: { experimentalApi: boolean };
    };
    expect(initialize.clientInfo.name).toBe("openclaw-local-session-source");
    expect(initialize.capabilities.experimentalApi).toBe(true);
    expect(
      daemon.requests.filter((r) => r.method === "thread/resume").map((r) => r.params),
    ).toEqual([{ threadId: "t-live" }]);
    // Stored-but-unloaded threads are never read or published: consent covers live work.
    expect(daemon.requests.some((r) => r.method === "thread/list")).toBe(false);
    expect(daemon.requests.some((r) => r.method === "thread/read")).toBe(false);

    const liveSession = host.sessions.find((s) => s.threadId === "t-live");
    expect(liveSession).toMatchObject({
      state: "active",
      canInput: true,
      title: "Preview of t-live",
      cwd: "/repo/t-live",
      startedAt: 1_700_000_000_000,
    });
    // Nothing older than the bootstrap exists on the laptop, so no history notice.
    expect(liveSession).not.toHaveProperty("earliestSeq");
    expect(recordsFor(host, "t-live")).toEqual([
      expect.objectContaining({
        id: "u1",
        seq: 1,
        kind: "user",
        clientId: "client-u1",
        turnId: "turn-1",
      }),
      expect.objectContaining({ id: "a1", seq: 2, kind: "assistant", text: "hello" }),
      expect.objectContaining({
        id: "c1",
        seq: 3,
        kind: "toolCall",
        toolName: "shell",
        text: "ls",
      }),
      expect.objectContaining({ id: "c1:result", seq: 4, kind: "toolResult", text: "file.txt" }),
    ]);
    expect(host.sessions.some((s) => s.threadId === "t-idle")).toBe(false);
    expect(host.sessions.some((s) => s.threadId === "t-excluded")).toBe(false);

    abort.abort();
    await session.stop();
  });

  it("appends live items with continuous seq and relays deltas and turns", async () => {
    const { abort, host, session } = await startSession(daemon);
    await vi.waitFor(() => expect(recordsFor(host, "t-live").length).toBe(4));

    daemon.notify("turn/started", {
      threadId: "t-live",
      turn: { id: "turn-2", status: "inProgress", items: [] },
    });
    daemon.notify("item/agentMessage/delta", {
      threadId: "t-live",
      turnId: "turn-2",
      itemId: "a2",
      delta: "wor",
    });
    daemon.notify("item/completed", {
      threadId: "t-live",
      turnId: "turn-2",
      item: { type: "agentMessage", id: "a2", text: "world" },
      completedAtMs: 1_700_000_200_000,
    });
    // Replayed completion for an item already published must not consume a seq.
    daemon.notify("item/completed", {
      threadId: "t-live",
      turnId: "turn-1",
      item: { type: "agentMessage", id: "a1", text: "hello" },
      completedAtMs: 1_700_000_201_000,
    });
    daemon.notify("turn/completed", {
      threadId: "t-live",
      turn: { id: "turn-2", status: "interrupted", items: [] },
    });
    daemon.notify("item/completed", {
      threadId: "t-unknown",
      turnId: "turn-x",
      item: { type: "agentMessage", id: "zz", text: "ignored" },
      completedAtMs: 1,
    });

    await vi.waitFor(() => expect(host.turns.length).toBe(2));
    expect(recordsFor(host, "t-live").slice(4)).toEqual([
      expect.objectContaining({ id: "a2", seq: 5, turnId: "turn-2", ts: 1_700_000_200_000 }),
    ]);
    expect(host.deltas).toEqual([
      { threadId: "t-live", turnId: "turn-2", itemId: "a2", text: "wor" },
    ]);
    expect(host.turns).toEqual([
      { threadId: "t-live", turnId: "turn-2", state: "started" },
      { threadId: "t-live", turnId: "turn-2", state: "interrupted" },
    ]);

    abort.abort();
    await session.stop();
  });

  it("steers via turn/start and queues follow-ups on active threads", async () => {
    const { abort, host, session } = await startSession(daemon);
    await vi.waitFor(() => expect(host.records.length).toBe(1));

    await session.submitInput({
      type: "input",
      inputId: "input-steer-0001",
      threadId: "t-live",
      mode: "steer",
      text: "focus on tests",
      sender: { displayName: "Ada" },
    });
    await session.submitInput({
      type: "input",
      inputId: "input-followup-01",
      threadId: "t-live",
      mode: "followup",
      text: "then lint",
      sender: { displayName: "Ada" },
    });

    const turnStart = daemon.requests.find((r) => r.method === "turn/start")?.params;
    expect(turnStart).toEqual({
      threadId: "t-live",
      input: [{ type: "text", text: "[Ada via OpenClaw team · message input-st]\nfocus on tests" }],
      clientUserMessageId: "input-steer-0001",
    });
    expect(daemon.requests.find((r) => r.method === "thread/queue/add")?.params).toMatchObject({
      threadId: "t-live",
      clientUserMessageId: "input-followup-01",
    });
    expect(host.inputResults).toEqual([
      {
        inputId: "input-steer-0001",
        threadId: "t-live",
        outcome: "committed",
        nativeRef: "turn-new",
      },
      {
        inputId: "input-followup-01",
        threadId: "t-live",
        outcome: "submitted",
        nativeRef: "queued-1",
      },
    ]);

    abort.abort();
    await session.stop();
  });

  it("closes an unloaded thread and refuses to wake it from the team", async () => {
    const { abort, host, session } = await startSession(daemon);
    await vi.waitFor(() => expect(host.records.length).toBe(1));

    daemon.notify("thread/closed", { threadId: "t-live" });
    await vi.waitFor(() =>
      expect(host.sessions.at(-1)).toMatchObject({
        threadId: "t-live",
        state: "closed",
        reason: "unloaded on the device",
      }),
    );
    await session.submitInput({
      type: "input",
      inputId: "input-idle-000001",
      threadId: "t-live",
      mode: "followup",
      text: "continue",
      sender: { displayName: "Ada" },
    });

    expect(daemon.requests.map((r) => r.method)).not.toContain("turn/start");
    expect(host.inputResults).toEqual([
      expect.objectContaining({
        inputId: "input-idle-000001",
        outcome: "rejected",
        reason: expect.stringContaining("closed"),
      }),
    ]);

    // The owner resumes it locally: the daemon reports it loaded and the row reopens.
    daemon.notify("thread/status/changed", { threadId: "t-live", status: { type: "idle" } });
    await vi.waitFor(() =>
      expect(host.sessions.at(-1)).toMatchObject({ threadId: "t-live", canInput: true }),
    );
    expect(host.sessions.at(-1)?.state).not.toBe("closed");
    await session.submitInput({
      type: "input",
      inputId: "input-idle-000002",
      threadId: "t-live",
      mode: "steer",
      text: "continue",
      sender: { displayName: "Ada" },
    });
    expect(host.inputResults.at(-1)).toMatchObject({
      inputId: "input-idle-000002",
      outcome: "committed",
    });

    abort.abort();
    await session.stop();
  });

  it("reports rpc failures as rejected without retrying", async () => {
    daemon.handlers.set("turn/start", () => {
      throw new Error("thread is busy");
    });
    const { abort, host, session } = await startSession(daemon);
    await vi.waitFor(() => expect(host.records.length).toBe(1));

    await session.submitInput({
      type: "input",
      inputId: "input-fail-0000001",
      threadId: "t-live",
      mode: "steer",
      text: "x",
      sender: { displayName: "Ada" },
    });

    expect(daemon.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
    expect(host.inputResults[0]).toMatchObject({
      outcome: "rejected",
      reason: expect.stringContaining("busy"),
    });

    abort.abort();
    await session.stop();
  });

  it("keeps an uncertain submission submitted instead of retryable", async () => {
    daemon.handlers.set("turn/start", () => {
      // The daemon vanishes after receiving the request: it may have run the turn.
      daemon.dropConnection();
      return { turn: { id: "turn-lost" } };
    });
    const { abort, host, session } = await startSession(daemon);
    await vi.waitFor(() => expect(host.records.length).toBe(1));

    await session.submitInput({
      type: "input",
      inputId: "input-lost-0000001",
      threadId: "t-live",
      mode: "steer",
      text: "x",
      sender: { displayName: "Ada" },
    });

    expect(host.inputResults[0]).toMatchObject({
      outcome: "submitted",
      reason: expect.stringContaining("uncertain"),
    });

    abort.abort();
    await session.stop();
  });

  it("never answers server-initiated requests", async () => {
    const { abort, host, session } = await startSession(daemon);
    await vi.waitFor(() => expect(host.records.length).toBe(1));

    daemon.sendServerRequest(77, "item/commandExecution/requestApproval", {
      threadId: "t-live",
      turnId: "turn-1",
      itemId: "c9",
    });
    daemon.notify("item/completed", {
      threadId: "t-live",
      turnId: "turn-1",
      item: { type: "agentMessage", id: "after", text: "after approval" },
      completedAtMs: 5,
    });
    await vi.waitFor(() => expect(recordsFor(host, "t-live").length).toBe(5));

    expect(daemon.clientResponses).toEqual([]);

    abort.abort();
    await session.stop();
  });

  it("unshare closes the thread and ignores it afterwards", async () => {
    const { abort, host, session } = await startSession(daemon);
    await vi.waitFor(() => expect(host.records.length).toBe(1));

    session.unshare("t-live");
    await vi.waitFor(() =>
      expect(host.sessions.at(-1)).toMatchObject({
        threadId: "t-live",
        state: "closed",
        canInput: false,
        reason: "unshared",
      }),
    );
    daemon.notify("item/completed", {
      threadId: "t-live",
      turnId: "turn-1",
      item: { type: "agentMessage", id: "late", text: "late" },
      completedAtMs: 5,
    });
    await session.submitInput({
      type: "input",
      inputId: "input-after-unshare",
      threadId: "t-live",
      mode: "steer",
      text: "x",
      sender: { displayName: "Ada" },
    });

    expect(recordsFor(host, "t-live").some((r) => r.id === "late")).toBe(false);
    expect(host.inputResults[0]).toMatchObject({ outcome: "rejected" });
    expect(daemon.requests.some((r) => r.method === "turn/start")).toBe(false);

    abort.abort();
    await session.stop();
  });

  it("publishes threads unavailable on disconnect and resumes from sent seqs after reconnect", async () => {
    const { abort, host, session } = await startSession(daemon);
    await vi.waitFor(() => expect(host.records.length).toBe(1));
    vi.useFakeTimers();

    daemon.dropConnection();
    await vi.waitFor(() =>
      expect(
        host.sessions
          .filter((s) => s.state === "unavailable")
          .map((s) => s.threadId)
          .toSorted(),
      ).toEqual(["t-live"]),
    );
    expect(host.sessions.find((s) => s.state === "unavailable")).toMatchObject({
      canInput: false,
      reason: "codex daemon disconnected",
    });

    const recordFramesBefore = host.records.length;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(daemon.connections).toBe(2));
    await vi.waitFor(() =>
      expect(host.sessions.at(-1)).toMatchObject({
        threadId: "t-live",
        state: "active",
        canInput: true,
      }),
    );

    // History unchanged: nothing after the seqs already sent is replayed.
    expect(host.records.length).toBe(recordFramesBefore);

    abort.abort();
    await session.stop();
  });
});
