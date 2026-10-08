// Synthetic native history survives both Gateway processes; only OpenClaw authors its state.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
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
  "handoff",
  "recover",
  "close-loaded",
  "close-gone",
  "verify-repeat",
]);
const threads = new Map();
const injectedItemsByThread = new Map();
const threadConfigurations = new Map();
const subscriptions = new Map();
const loaded = new Set();
const closeTurns = new Map();
let turnSequence = 0;
let parentSequence = 0;
let seededAssignments = false;
let historyPruned = false;

function readPhase() {
  const { phase } = JSON.parse(fs.readFileSync(values["phase-file"], "utf8"));
  if (!phases.has(phase)) {
    throw new Error("Unknown native assignment fixture phase");
  }
  if (!phase.startsWith("seed-") && phase !== "handoff" && !historyPruned) {
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

function startThread(params, requestedId) {
  let id = requestedId;
  if (id === undefined) {
    parentSequence += 1;
    id = parentSequence === 1 ? parentId : `${parentId}-${parentSequence}`;
  }
  if (threads.has(id)) {
    throw new Error("Synthetic thread/start must create a fresh thread");
  }
  const response = createFakeThreadStartResponse({
    params,
    threadId: id,
    sessionId: "native-upgrade-provider-session",
    version,
  });
  response.thread.createdAt = Math.floor(Date.now() / 1000);
  response.thread.updatedAt = response.thread.createdAt;
  if (id === runningId || id === completeId) {
    response.thread.parentThreadId = parentId;
    response.thread.source = {
      subAgent: {
        thread_spawn: { parent_thread_id: parentId, depth: 1, agent_path: `/root/${id}` },
      },
    };
    response.thread.preview = "Synthetic native upgrade assignment";
  }
  threads.set(id, response.thread);
  injectedItemsByThread.set(id, []);
  threadConfigurations.set(id, { params: structuredClone(params), response });
  loaded.add(id);
  return { ...threadConfigurations.get(id).response, thread: thread(id) };
}

function resumeChangesConfiguration(params, configured) {
  if (
    ["config", "baseInstructions", "developerInstructions", "permissions"].some(
      (key) => params[key] != null,
    )
  ) {
    return true;
  }
  return [
    "model",
    "modelProvider",
    "serviceTier",
    "cwd",
    "runtimeWorkspaceRoots",
    "approvalPolicy",
    "approvalsReviewer",
    "sandbox",
    "personality",
  ].some((key) => {
    const requested = params[key];
    if (requested == null && !(key === "serviceTier" && Object.hasOwn(params, key))) {
      return false;
    }
    const current =
      configured.params[key] ??
      (key === "sandbox" ? "danger-full-access" : configured.response[key]);
    return !isDeepStrictEqual(requested, current);
  });
}

function resumeThread(socket, phase, params) {
  const selected = thread(params.threadId);
  const configured = threadConfigurations.get(params.threadId);
  const hasSubscribers = [...subscriptions.values()].some((ids) => ids.has(params.threadId));
  const reload =
    !loaded.has(params.threadId) ||
    (resumeChangesConfiguration(params, configured) &&
      selected.status.type === "idle" &&
      !hasSubscribers);
  if (reload) {
    const overrides = Object.fromEntries(
      Object.entries(params).filter(([key, value]) => value != null || key === "serviceTier"),
    );
    const nextParams = { ...configured.params, ...overrides };
    if (nextParams.sandbox != null && nextParams.sandbox !== "danger-full-access") {
      throw new Error("Native upgrade fixture only supports the configured full-access sandbox");
    }
    const response = createFakeThreadStartResponse({
      params: nextParams,
      threadId: params.threadId,
      sessionId: "native-upgrade-provider-session",
      version,
    });
    response.modelProvider = nextParams.modelProvider ?? response.modelProvider;
    response.serviceTier = nextParams.serviceTier ?? null;
    response.runtimeWorkspaceRoots =
      nextParams.runtimeWorkspaceRoots ?? response.runtimeWorkspaceRoots;
    if (loaded.delete(params.threadId)) {
      selected.status = { type: "notLoaded" };
      notify(socket, phase, "thread/status/changed", {
        threadId: params.threadId,
        status: selected.status,
      });
    }
    // This v1 fixture's status is its execution state. Reconfigure only an idle,
    // unsubscribed cache entry; retain its history and injected model context.
    selected.cwd = response.cwd;
    selected.modelProvider = response.modelProvider;
    selected.status = { type: "idle" };
    threadConfigurations.set(params.threadId, { params: structuredClone(nextParams), response });
    loaded.add(params.threadId);
  }
  subscriptions.get(socket).add(params.threadId);
  return { ...threadConfigurations.get(params.threadId).response, thread: selected };
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
  thread(threadId).status = { type: "active", activeFlags: [] };
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

function collabItem(socket, phase, threadId, turn, item, method) {
  if (method === "item/completed") {
    turn.items.push(item);
  }
  notify(socket, phase, method, { threadId, turnId: turn.id, item });
}

function runPhase(socket, phase, threadId, turn, input) {
  if (turn.status !== "inProgress") {
    return;
  }
  if (
    phase === "seed-assignments" &&
    threadId === parentId &&
    input.some(
      (item) => item.type === "text" && item.text.includes("NATIVE_UPGRADE_SEED_ASSIGNMENTS"),
    )
  ) {
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
        threadId,
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
  if (
    (phase === "close-loaded" || phase === "close-gone") &&
    input.some(
      (item) =>
        item.type === "text" &&
        item.text.includes(`Continue the synthetic native upgrade fixture: ${phase}.`),
    )
  ) {
    if (closeTurns.has(socket)) {
      throw new Error("Native close confirmation is already pending on this connection");
    }
    const item = {
      id: `${phase}-${turn.id}`,
      type: "collabAgentToolCall",
      tool: "closeAgent",
      status: "inProgress",
      senderThreadId: threadId,
      receiverThreadIds: [runningId],
      agentsStates: {},
    };
    closeTurns.set(socket, { phase, threadId, turn });
    collabItem(socket, phase, threadId, turn, item, "item/started");
    collabItem(
      socket,
      phase,
      threadId,
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
    threadId,
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
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Low reasoning effort" },
            ],
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
    case "thread/start": {
      const response = startThread(params);
      subscriptions.get(socket).add(response.thread.id);
      return result(response);
    }
    case "thread/resume":
      return result(resumeThread(socket, phase, params));
    case "thread/inject_items": {
      thread(params.threadId);
      if (
        !Array.isArray(params.items) ||
        !params.items.every(
          (item) =>
            item?.type === "message" &&
            item.role === "developer" &&
            Array.isArray(item.content) &&
            item.content.every(
              (part) => part?.type === "input_text" && typeof part.text === "string",
            ),
        )
      ) {
        throw new Error("Native upgrade fixture injection requires developer text items");
      }
      // Raw model context has no transcript turn and must not expose policy text in proof logs.
      const items = injectedItemsByThread.get(params.threadId);
      items.push(...structuredClone(params.items));
      log("fixture-state", phase, {
        event: "response-items-appended",
        threadId: params.threadId,
        appendedCount: params.items.length,
        totalCount: items.length,
      });
      return result({});
    }
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
      subscriptions.get(socket).add(params.threadId);
      return result({});
    case "thread/unsubscribe": {
      if (!loaded.has(params.threadId)) {
        return result({ status: "notLoaded" });
      }
      const removed = subscriptions.get(socket).delete(params.threadId);
      return result({ status: removed ? "unsubscribed" : "notSubscribed" });
    }
    case "turn/start": {
      if ([runningId, completeId].includes(params.threadId)) {
        throw new Error("Only parent turns may be started through this fixture");
      }
      const turnId = `native-parent-turn-${++turnSequence}`;
      const turn = startTurn(socket, phase, params.threadId, turnId);
      result({ turn });
      setImmediate(() => {
        try {
          runPhase(socket, phase, params.threadId, turn, params.input ?? []);
        } catch (error) {
          log("fixture-error", phase, { message: error.message });
          completeTurn(
            socket,
            phase,
            params.threadId,
            turn,
            "NATIVE_UPGRADE_FIXTURE_ERROR",
            "failed",
          );
        }
      });
      return;
    }
    case "turn/interrupt": {
      if ([runningId, completeId].includes(params.threadId)) {
        throw new Error("This fixture only interrupts parent turns");
      }
      const turn = thread(params.threadId).turns.find((value) => value.id === params.turnId);
      if (turn?.status !== "inProgress") {
        throw new Error("No active synthetic parent turn to interrupt");
      }
      result({});
      setImmediate(() =>
        completeTurn(socket, phase, params.threadId, turn, undefined, "interrupted"),
      );
      return;
    }
    case "thread/loaded/list": {
      const closing = closeTurns.get(socket);
      if (closing?.phase === "close-gone") {
        loaded.delete(runningId);
        for (const ids of subscriptions.values()) {
          ids.delete(runningId);
        }
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
            closing.threadId,
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
  subscriptions.set(socket, new Set());
  socket.on("close", () => {
    closeTurns.delete(socket);
    subscriptions.delete(socket);
  });
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
