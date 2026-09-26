// Synthetic native history survives both Gateway processes; only OpenClaw authors its state.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  createFakeInitializeResponse,
  createFakeThreadStartResponse,
} from "../codex-app-server-fixture.mjs";

const { values } = parseArgs({
  options: Object.fromEntries(
    ["package-root", "ready-file", "phase-file", "log-file"].map((name) => [
      name,
      { type: "string" },
    ]),
  ),
});
for (const name of ["package-root", "ready-file", "phase-file", "log-file"]) {
  if (!values[name]) {
    throw new Error(`Missing --${name}`);
  }
}
const requirePackage = createRequire(
  path.join(path.resolve(values["package-root"]), "package.json"),
);
const { WebSocketServer, WebSocket } = requirePackage("ws");
const version = "0.155.1";
const parentId = "native-upgrade-parent";
const runningId = "native-upgrade-running";
const completeId = "native-upgrade-complete";
const phases = new Set([
  "seed-history",
  "seed-assignments",
  "recover",
  "close-loaded",
  "close-gone",
  "verify-repeat",
]);
const threads = new Map();
const loaded = new Set();
const closeTurns = new Map();
let turnSequence = 0;
let seededAssignments = false;
let historyPruned = false;

function readPhase() {
  const { phase } = JSON.parse(fs.readFileSync(values["phase-file"], "utf8"));
  if (!phases.has(phase)) {
    throw new Error("Unknown native assignment fixture phase");
  }
  if (!phase.startsWith("seed-") && !historyPruned) {
    // Recovery must use the imported locator/result, not rediscover old spawn events.
    for (const turn of threads.get(parentId)?.turns ?? []) {
      turn.items = turn.items.filter((item) => item.type !== "collabAgentToolCall");
    }
    const completed = threads.get(completeId);
    if (completed) {
      completed.turns = [];
    }
    historyPruned = true;
  }
  return phase;
}

function log(direction, phase, message) {
  fs.appendFileSync(values["log-file"], `${JSON.stringify({ direction, phase, ...message })}\n`);
}

function requestEvidence(message) {
  const { id, method, params } = message;
  if (method === "account/login/start") {
    return { id, method, params: "[redacted]" };
  }
  // Never copy thread config, dynamic tools, credentials, or incidental prompt text into proof logs.
  const safe = {};
  for (const field of ["threadId", "turnId", "includeTurns", "cursor", "limit"]) {
    if (params?.[field] !== undefined) {
      safe[field] = params[field];
    }
  }
  if (Array.isArray(params?.input)) {
    safe.input = params.input.map((input) => {
      const entry = { type: input.type };
      if (typeof input.text === "string") {
        entry.text = (input.text.match(/NATIVE_UPGRADE_[A-Z0-9_]+/gu) ?? []).join(" ");
      }
      return entry;
    });
  }
  return { id, method, params: safe };
}

function send(socket, phase, message) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  log(message.method ? "notification" : "response", phase, message);
  socket.send(JSON.stringify(message));
}

function notify(socket, phase, method, params) {
  send(socket, phase, { method, params });
}

function thread(id) {
  const value = threads.get(id);
  if (!value) {
    throw new Error("Unknown synthetic native thread");
  }
  return value;
}

function startThread(params, id = parentId) {
  const response = createFakeThreadStartResponse({
    params,
    threadId: id,
    sessionId: "native-upgrade-provider-session",
    version,
  });
  if (!threads.has(id)) {
    response.thread.createdAt = Math.floor(Date.now() / 1000);
    response.thread.updatedAt = response.thread.createdAt;
    if (id !== parentId) {
      response.thread.parentThreadId = parentId;
      response.thread.source = {
        subAgent: {
          thread_spawn: { parent_thread_id: parentId, depth: 1, agent_path: `/root/${id}` },
        },
      };
      response.thread.preview = "Synthetic native upgrade assignment";
    }
    threads.set(id, response.thread);
  }
  loaded.add(id);
  return { ...response, thread: thread(id) };
}

function startTurn(socket, phase, threadId, turnId) {
  const turn = {
    id: turnId,
    status: "inProgress",
    items: [],
    itemsView: "full",
    error: null,
    startedAt: Math.floor(Date.now() / 1000),
    completedAt: null,
    durationMs: null,
  };
  thread(threadId).turns.push(turn);
  thread(threadId).status = { type: "active" };
  notify(socket, phase, "turn/started", { threadId, turn });
  return turn;
}

function completeTurn(socket, phase, threadId, turn, text, status = "completed") {
  if (turn.status !== "inProgress") {
    return;
  }
  if (text) {
    const item = { id: `${turn.id}-final`, type: "agentMessage", phase: "final_answer", text };
    turn.items.push(item);
    notify(socket, phase, "item/completed", { threadId, turnId: turn.id, item });
  }
  turn.status = status;
  turn.completedAt = Math.floor(Date.now() / 1000);
  turn.durationMs = 0;
  thread(threadId).status = { type: "idle" };
  notify(socket, phase, "turn/completed", { threadId, turn });
  notify(socket, phase, "thread/status/changed", { threadId, status: { type: "idle" } });
}

function collabItem(socket, phase, turn, item, method) {
  if (method === "item/completed") {
    turn.items.push(item);
  }
  notify(socket, phase, method, { threadId: parentId, turnId: turn.id, item });
}

function runPhase(socket, phase, turn) {
  if (phase === "seed-assignments") {
    if (seededAssignments) {
      throw new Error("Native assignments were already seeded");
    }
    seededAssignments = true;
    for (const [id, turnId] of [
      [runningId, "native-running-turn"],
      [completeId, "native-complete-turn"],
    ]) {
      const child = startThread({ cwd: thread(parentId).cwd }, id).thread;
      notify(socket, phase, "thread/started", { thread: child });
      collabItem(
        socket,
        phase,
        turn,
        {
          id: `spawn-${id}`,
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: parentId,
          receiverThreadIds: [id],
          prompt: "Synthetic native upgrade assignment",
          agentsStates: { [id]: { status: "running", message: null } },
        },
        "item/completed",
      );
      const childTurn = startTurn(socket, phase, id, turnId);
      if (id === completeId) {
        completeTurn(socket, phase, id, childTurn, "NATIVE_UPGRADE_PENDING_RESULT");
      }
    }
    return;
  }
  if (phase === "close-loaded" || phase === "close-gone") {
    const item = {
      id: `${phase}-${turn.id}`,
      type: "collabAgentToolCall",
      tool: "closeAgent",
      status: "inProgress",
      senderThreadId: parentId,
      receiverThreadIds: [runningId],
      agentsStates: {},
    };
    closeTurns.set(socket, { phase, turn });
    collabItem(socket, phase, turn, item, "item/started");
    collabItem(
      socket,
      phase,
      turn,
      {
        ...item,
        status: "completed",
        agentsStates: { [runningId]: { status: "running", message: null } },
      },
      "item/completed",
    );
    return;
  }
  completeTurn(
    socket,
    phase,
    parentId,
    turn,
    phase === "seed-history" ? "NATIVE_UPGRADE_RETAINED_HISTORY" : "NATIVE_UPGRADE_PARENT_OK",
  );
}

function handle(socket, phase, message) {
  const { id, method, params = {} } = message;
  const result = (value) => send(socket, phase, { id, result: value });
  switch (method) {
    case "initialize":
      return result({
        ...createFakeInitializeResponse({
          name: "native-upgrade-fixture",
          version,
          userAgent: `codex-cli/${version}`,
        }),
        codexHome: "/synthetic/native-upgrade-codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      });
    case "account/read":
      return result({ account: { type: "apiKey" }, requiresOpenaiAuth: false });
    case "account/login/start":
      return result({ type: "apiKey" });
    case "account/rateLimits/read":
      return result({ rateLimits: null, rateLimitsByLimitId: null });
    case "model/list":
      return result({
        data: [
          {
            id: "gpt-5.6-luna",
            model: "gpt-5.6-luna",
            displayName: "gpt-5.6-luna",
            description: "Synthetic upgrade proof model",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [{ reasoningEffort: "low" }],
            multiAgentVersion: "v1",
            inputModalities: ["text"],
          },
        ],
        nextCursor: null,
      });
    case "config/read":
      return result({ config: {}, origins: {}, layers: [] });
    case "configRequirements/read":
      return result({ requirements: null });
    case "modelProvider/capabilities/read":
      return result({ namespaceTools: true, imageGeneration: false, webSearch: false });
    case "skills/list":
      return result({ data: (params.cwds ?? []).map((cwd) => ({ cwd, skills: [], errors: [] })) });
    case "hooks/list":
      return result({
        data: (params.cwds ?? []).map((cwd) => ({ cwd, hooks: [], errors: [], warnings: [] })),
        nextCursor: null,
      });
    case "mcpServerStatus/list":
      return result({ data: [], nextCursor: null });
    case "thread/start":
      return result(startThread(params));
    case "thread/resume":
      thread(params.threadId);
      return result(startThread(params, params.threadId));
    case "thread/read": {
      const selected = thread(params.threadId);
      return result({ thread: { ...selected, turns: params.includeTurns ? selected.turns : [] } });
    }
    case "thread/list":
      return result({
        data: [...threads.values()].map((value) => Object.assign({}, value, { turns: [] })),
        nextCursor: null,
      });
    case "thread/turns/list": {
      const turns = [...thread(params.threadId).turns];
      if (params.sortDirection !== "asc") {
        turns.reverse();
      }
      return result({ data: turns.slice(0, params.limit ?? turns.length), nextCursor: null });
    }
    case "thread/subscribe":
      thread(params.threadId);
      loaded.add(params.threadId);
      return result({});
    case "thread/unsubscribe":
      thread(params.threadId);
      return result({});
    case "turn/start": {
      if (params.threadId !== parentId) {
        throw new Error("Only parent turns may be started through this fixture");
      }
      const turnId = `native-parent-turn-${++turnSequence}`;
      const turn = startTurn(socket, phase, parentId, turnId);
      result({ turn });
      setImmediate(() => {
        try {
          runPhase(socket, phase, turn);
        } catch (error) {
          log("fixture-error", phase, { message: error.message });
          completeTurn(socket, phase, parentId, turn, "NATIVE_UPGRADE_FIXTURE_ERROR", "failed");
        }
      });
      return;
    }
    case "turn/interrupt": {
      if (params.threadId !== parentId) {
        throw new Error("This fixture only interrupts parent turns");
      }
      const turn = thread(parentId).turns.find((value) => value.id === params.turnId);
      if (!turn) {
        throw new Error("Unknown synthetic parent turn");
      }
      result({});
      completeTurn(socket, phase, parentId, turn, undefined, "interrupted");
      return;
    }
    case "thread/loaded/list": {
      const closing = closeTurns.get(socket);
      if (closing?.phase === "close-gone") {
        loaded.delete(runningId);
        thread(runningId).status = { type: "notLoaded" };
      }
      // Closing proof uses one complete snapshot; the already-finished child is irrelevant.
      result({ data: [...loaded].filter((value) => value !== completeId), nextCursor: null });
      if (closing) {
        closeTurns.delete(socket);
        setImmediate(() =>
          completeTurn(
            socket,
            closing.phase,
            parentId,
            closing.turn,
            "NATIVE_UPGRADE_CLOSE_OBSERVED",
          ),
        );
      }
      return;
    }
    default:
      log("unsupported-method", phase, { method });
      return send(socket, phase, {
        id,
        error: { code: -32601, message: "Unsupported native upgrade fixture method" },
      });
  }
}

fs.mkdirSync(path.dirname(values["log-file"]), { recursive: true });
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
server.on("connection", (socket) => {
  socket.on("close", () => closeTurns.delete(socket));
  socket.on("message", (bytes) => {
    let message;
    let phase;
    try {
      phase = readPhase();
      message = JSON.parse(bytes.toString("utf8"));
      log("request", phase, requestEvidence(message));
      if (message.id === undefined && message.method === "initialized") {
        return;
      }
      if (message.id === undefined || typeof message.method !== "string") {
        throw new Error("Expected a Codex RPC request");
      }
      handle(socket, phase, message);
    } catch (error) {
      log("fixture-error", phase ?? "unknown", { message: error.message });
      if (message?.id !== undefined) {
        send(socket, phase ?? "unknown", {
          id: message.id,
          error: { code: -32603, message: error.message },
        });
      }
    }
  });
});
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const { port } = server.address();
fs.mkdirSync(path.dirname(values["ready-file"]), { recursive: true });
fs.writeFileSync(
  values["ready-file"],
  `${JSON.stringify({ url: `ws://127.0.0.1:${port}`, port })}\n`,
);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    for (const socket of server.clients) {
      socket.terminate();
    }
    server.close();
  });
}
