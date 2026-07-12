// Parse OpenClaw logs + optional stability bundles into per-run timing events.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RUN_ID_RE = /\brunId=([^\s,"]+)/u;
const SESSION_KEY_RE = /\bsessionKey=([^\s,"]+)/u;
const SESSION_ID_RE = /\bsessionId=([^\s,"]+)/u;
const DURATION_MS_RE = /\bdurationMs=(\d+(?:\.\d+)?)/u;
const DURATION_RE = /\bduration=(\d+(?:\.\d+)?)ms\b/u;
const EMBEDDED_RUN_START_RE =
  /^embedded run start: runId=([^\s]+) sessionId=([^\s]+) provider=([^\s]+) model=([^\s]+)/u;
const EMBEDDED_RUN_AGENT_START_RE = /^embedded run agent start: runId=([^\s]+)/u;
const EMBEDDED_RUN_AGENT_END_RE = /^embedded run agent end: runId=([^\s]+) isError=(true|false)/u;
const TRACE_EMBEDDED_RUN_RE =
  /^\[trace:embedded-run\] ([^:]+): runId=([^\s]+) sessionId=([^\s]+) phase=([^\s]+) totalMs=(\d+) stages=(.+)$/u;
const GATEWAY_WS_AGENT_RE = /^⇄ res [✓✗] agent (\d+(?:\.\d+)?)ms runId=([^\s]+)/u;
const STAGE_CHUNK_RE = /([^:,]+):(\d+)ms@(\d+)ms/gu;

const TIMING_EVENT_TYPES = new Set([
  "hook.handler.completed",
  "tool.execution.completed",
  "tool.execution.error",
  "model.call.completed",
  "model.call.error",
  "diagnostic.phase.completed",
  "run.started",
  "run.completed",
  "harness.run.completed",
  "harness.run.error",
]);

/** @typedef {import("../../src/types.ts").PerformanceEventKind} PerformanceEventKind */

/**
 * @typedef {Object} RunWindow
 * @property {string} runId
 * @property {number} startedAt
 * @property {number} [endedAt]
 * @property {string} [sessionKey]
 * @property {string} [sessionId]
 * @property {string} [provider]
 * @property {string} [model]
 * @property {string} [outcome]
 */

/**
 * @typedef {Object} TimingRow
 * @property {string} runId
 * @property {string} [sessionKey]
 * @property {string} [sessionId]
 * @property {PerformanceEventKind | "log"} kind
 * @property {number} at
 * @property {number} [durationMs]
 * @property {string} [outcome]
 * @property {string} [extensionId]
 * @property {string} [hookName]
 * @property {string} [toolName]
 * @property {string} [handlerName]
 * @property {string} [handlerSource]
 * @property {string} [handlerRef]
 * @property {string} [toolSource]
 * @property {string} [mcpServerName]
 * @property {string} [provider]
 * @property {string} [model]
 * @property {string} [providerPluginId]
 * @property {string} [harnessId]
 * @property {string} [api]
 * @property {string} [transport]
 * @property {string} [phaseName]
 * @property {string} [callId]
 * @property {string} [toolCallId]
 * @property {"log" | "stability"} source
 * @property {number} [seq]
 * @property {string} [correlation]
 * @property {string} [logMessage]
 */

export function resolveDefaultLogPaths(env = process.env) {
  const home = env.HOME?.trim() || os.homedir();
  const stateDir = env.OPENCLAW_STATE_DIR?.trim()
    ? expandHome(env.OPENCLAW_STATE_DIR.trim(), home)
    : path.join(home, ".openclaw");
  const stateLogsDir = path.join(stateDir, "logs");
  const posixTmpLogsDir = path.join("/tmp", "openclaw");
  const tmpLogsDir = path.join(os.tmpdir(), "openclaw");
  const logsDir = pickExistingLogsDir(stateLogsDir, posixTmpLogsDir, tmpLogsDir);
  const stabilityDir = path.join(stateDir, "logs", "stability");
  return { stateDir, logsDir, stabilityDir, tmpLogsDir: posixTmpLogsDir };
}

function pickExistingLogsDir(...candidates) {
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    const hasLogs = fs
      .readdirSync(dir)
      .some((name) => /^openclaw(-\d{4}-\d{2}-\d{2})?\.log$/u.test(name));
    if (hasLogs) {
      return dir;
    }
  }
  return candidates[0] ?? path.join(os.tmpdir(), "openclaw");
}

function expandHome(input, home) {
  if (input.startsWith("~/")) {
    return path.join(home, input.slice(2));
  }
  return input;
}

function roundMs(value) {
  return Math.round(value * 10) / 10;
}

function parseTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readFirstString(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function extractKeyValues(text) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!text) {
    return out;
  }
  for (const match of text.matchAll(/\b([A-Za-z_.][A-Za-z0-9_.-]*)=([^\s,"]+)/gu)) {
    out[match[1]] = match[2];
  }
  return out;
}

/**
 * @param {string} line
 * @returns {{ time?: number, subsystem?: string, level?: string, message?: string, raw: Record<string, unknown> } | undefined}
 */
export function parseOpenClawLogLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }
  if (!trimmed.startsWith("{")) {
    return {
      message: trimmed,
      raw: { msg: trimmed },
    };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = /** @type {Record<string, unknown>} */ (parsed);
    const message =
      readFirstString(record, ["message", "msg"]) ??
      (typeof record["1"] === "string" ? record["1"] : undefined);
    const subsystem =
      readFirstString(record, ["subsystem", "component"]) ?? parseSubsystemFromBinding(record["0"]);
    const level =
      readFirstString(record, ["level"]) ?? readNestedString(record._meta, ["logLevelName"]);
    const time = parseTime(record.time) ?? parseTime(record.ts) ?? parseNestedTime(record._meta);
    return { time, subsystem, level, message, raw: record };
  } catch {
    return { message: trimmed, raw: { msg: trimmed } };
  }
}

function parseSubsystemFromBinding(value) {
  if (typeof value !== "string" || !value.trim().startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return readFirstString(/** @type {Record<string, unknown>} */ (parsed), [
        "subsystem",
        "module",
      ]);
    }
  } catch {
    // ignore
  }
  return undefined;
}

function readNestedString(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return readFirstString(/** @type {Record<string, unknown>} */ (value), keys);
}

function parseNestedTime(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const date = /** @type {{ date?: unknown }} */ (meta).date;
  if (date instanceof Date) {
    return date.getTime();
  }
  return undefined;
}

function collectContextFromRecord(record) {
  const raw = record.raw;
  const message = record.message ?? "";
  const kv = extractKeyValues(message);
  const sessionKey = readFirstString(raw, ["sessionKey", "session_key"]) ?? kv.sessionKey;
  const sessionId = readFirstString(raw, ["sessionId", "session_id", "sessionKey"]) ?? kv.sessionId;
  const runId = readFirstString(raw, ["runId", "run_id"]) ?? kv.runId;
  return { sessionKey, sessionId, runId, kv, message };
}

/**
 * @param {ReturnType<typeof parseOpenClawLogLine>} record
 * @returns {Array<{ kind: "run_window"; runId: string; startedAt?: number; endedAt?: number; sessionKey?: string; sessionId?: string; provider?: string; model?: string; outcome?: string } | TimingRow>}
 */
export function extractEventsFromLogRecord(record) {
  if (!record) {
    return [];
  }
  const at = record.time ?? Date.now();
  const ctx = collectContextFromRecord(record);
  const message = ctx.message ?? "";
  const out = [];

  const startMatch = message.match(EMBEDDED_RUN_START_RE);
  if (startMatch) {
    out.push({
      kind: "run_window",
      runId: startMatch[1],
      startedAt: at,
      sessionId: startMatch[2],
      provider: startMatch[3],
      model: startMatch[4],
      sessionKey: ctx.sessionKey,
    });
  }

  const agentStartMatch = message.match(EMBEDDED_RUN_AGENT_START_RE);
  if (agentStartMatch) {
    out.push({
      kind: "run_window",
      runId: agentStartMatch[1],
      startedAt: at,
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
    });
  }

  const agentEndMatch = message.match(EMBEDDED_RUN_AGENT_END_RE);
  if (agentEndMatch) {
    out.push({
      kind: "run_window",
      runId: agentEndMatch[1],
      endedAt: at,
      outcome: agentEndMatch[2] === "true" ? "error" : "completed",
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
    });
  }

  const gatewayAgentMatch = message.match(GATEWAY_WS_AGENT_RE);
  if (gatewayAgentMatch) {
    const durationMs = roundMs(Number(gatewayAgentMatch[1]));
    const runId = gatewayAgentMatch[2];
    out.push({
      kind: "run_window",
      runId,
      startedAt: at - durationMs,
      endedAt: at,
      outcome: message.includes("✗") ? "error" : "completed",
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
    });
    out.push({
      runId,
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      kind: "run",
      at,
      durationMs,
      outcome: message.includes("✗") ? "error" : "completed",
      phaseName: "gateway.ws.agent",
      source: "log",
      logMessage: message,
    });
  }

  const traceMatch = message.match(TRACE_EMBEDDED_RUN_RE);
  if (traceMatch) {
    const [, label, runId, sessionId, phase, totalMsRaw, stagesRaw] = traceMatch;
    const totalMs = Number(totalMsRaw);
    out.push({
      runId,
      sessionId,
      sessionKey: ctx.sessionKey,
      kind: "phase",
      at,
      durationMs: roundMs(totalMs),
      phaseName: `${label}:${phase}`,
      outcome: "completed",
      source: "log",
      logMessage: message,
    });
    for (const stageMatch of stagesRaw.matchAll(STAGE_CHUNK_RE)) {
      out.push({
        runId,
        sessionId,
        sessionKey: ctx.sessionKey,
        kind: "phase",
        at,
        durationMs: roundMs(Number(stageMatch[2])),
        phaseName: `${label}:${phase}:${stageMatch[1]}`,
        outcome: "completed",
        source: "log",
        logMessage: message,
      });
    }
  }

  const runId = ctx.runId ?? message.match(RUN_ID_RE)?.[1];
  const durationMs = parseDurationMs(message, ctx.kv);
  if (runId && durationMs !== undefined) {
    const classified = classifyDurationLogMessage(message, ctx);
    if (classified) {
      out.push({
        runId,
        sessionKey: ctx.sessionKey ?? ctx.kv.sessionKey,
        sessionId: ctx.sessionId ?? ctx.kv.sessionId,
        kind: classified.kind,
        at,
        durationMs,
        outcome: classified.outcome,
        extensionId: classified.extensionId,
        hookName: classified.hookName,
        toolName: classified.toolName,
        handlerRef: classified.handlerRef,
        provider: classified.provider,
        model: classified.model,
        phaseName: classified.phaseName,
        source: "log",
        logMessage: message,
      });
    }
  }

  if (runId && !durationMs && /^(run attempt:|embedded run|agent cleanup)/u.test(message)) {
    out.push({
      runId,
      sessionKey: ctx.sessionKey ?? ctx.kv.sessionKey,
      sessionId: ctx.sessionId ?? ctx.kv.sessionId,
      kind: "run",
      at,
      outcome: message.includes("error") ? "error" : "info",
      source: "log",
      logMessage: message,
    });
  }

  return out;
}

function parseDurationMs(message, kv) {
  const fromKv = kv.durationMs ?? kv.duration;
  if (fromKv !== undefined) {
    const parsed = Number(fromKv);
    if (Number.isFinite(parsed)) {
      return roundMs(parsed);
    }
  }
  const durationMsMatch = message.match(DURATION_MS_RE);
  if (durationMsMatch) {
    return roundMs(Number(durationMsMatch[1]));
  }
  const durationMatch = message.match(DURATION_RE);
  if (durationMatch) {
    return roundMs(Number(durationMatch[1]));
  }
  return undefined;
}

function classifyDurationLogMessage(message, ctx) {
  if (message.includes("webhook processed")) {
    return { kind: "log", outcome: "completed", phaseName: "webhook.processed" };
  }
  if (message.includes("tool loop:")) {
    return {
      kind: "tool",
      outcome: message.includes("critical") ? "error" : "completed",
      toolName: ctx.kv.tool,
      phaseName: "tool.loop",
    };
  }
  if (message.includes("model fallback")) {
    return {
      kind: "llm",
      outcome: "completed",
      provider: ctx.kv.provider,
      model: ctx.kv.model,
      phaseName: "model.fallback",
    };
  }
  if (/tool execution|tool\.execution/u.test(message)) {
    return {
      kind: "tool",
      outcome: message.includes("error") ? "error" : "completed",
      toolName: ctx.kv.tool ?? ctx.kv.toolName,
      handlerRef: ctx.kv.handler ?? ctx.kv.handlerRef,
      extensionId: ctx.kv.pluginId ?? ctx.kv.toolOwner,
    };
  }
  if (/model call|model\.call/u.test(message)) {
    return {
      kind: "llm",
      outcome: message.includes("error") ? "error" : "completed",
      provider: ctx.kv.provider,
      model: ctx.kv.model,
      handlerRef: ctx.kv.handler ?? ctx.kv.handlerRef,
    };
  }
  if (/hook|before_tool_call|after_tool_call/u.test(message)) {
    return {
      kind: "hook_handler",
      outcome: message.includes("error") ? "error" : "completed",
      hookName: ctx.kv.hookName ?? ctx.kv.phase,
      extensionId: ctx.kv.pluginId,
    };
  }
  return {
    kind: "log",
    outcome: "completed",
    phaseName: message.slice(0, 120),
  };
}

/**
 * @param {Record<string, unknown>} record
 * @returns {TimingRow | undefined}
 */
export function stabilityRecordToTimingRow(record) {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const type = typeof record.type === "string" ? record.type : undefined;
  if (!type || !TIMING_EVENT_TYPES.has(type)) {
    return undefined;
  }
  const at = parseTime(record.ts);
  if (at === undefined) {
    return undefined;
  }
  const durationMs =
    typeof record.durationMs === "number" && Number.isFinite(record.durationMs)
      ? roundMs(record.durationMs)
      : undefined;
  const seq = typeof record.seq === "number" ? record.seq : undefined;

  /** @type {TimingRow} */
  const base = {
    runId: "",
    kind: "log",
    at,
    source: "stability",
    seq,
    correlation: "pending",
  };

  switch (type) {
    case "hook.handler.completed":
      return {
        ...base,
        kind: "hook_handler",
        durationMs,
        outcome: typeof record.outcome === "string" ? record.outcome : "completed",
        extensionId: typeof record.pluginId === "string" ? record.pluginId : undefined,
        hookName: typeof record.phase === "string" ? record.phase : undefined,
        ...(typeof record.handler === "string"
          ? parseHookHandlerIdentity(
              record.handler,
              typeof record.source === "string" ? record.source : undefined,
            )
          : typeof record.pluginId === "string" && typeof record.phase === "string"
            ? {
                handlerRef: `hook:${record.pluginId}:${record.phase}`,
              }
            : {}),
      };
    case "tool.execution.completed":
    case "tool.execution.error":
      return {
        ...base,
        kind: "tool",
        durationMs,
        outcome: type.endsWith("error") ? "error" : "completed",
        toolName: typeof record.toolName === "string" ? record.toolName : undefined,
        handlerRef: typeof record.handler === "string" ? record.handler : undefined,
        toolSource: typeof record.source === "string" ? record.source : undefined,
        extensionId: typeof record.pluginId === "string" ? record.pluginId : undefined,
        mcpServerName: typeof record.target === "string" ? record.target : undefined,
      };
    case "model.call.completed":
    case "model.call.error":
      return {
        ...base,
        kind: "llm",
        durationMs,
        outcome: type.endsWith("error") ? "error" : "completed",
        provider: typeof record.provider === "string" ? record.provider : undefined,
        model: typeof record.model === "string" ? record.model : undefined,
        providerPluginId: typeof record.pluginId === "string" ? record.pluginId : undefined,
        handlerRef: typeof record.handler === "string" ? record.handler : undefined,
        api: typeof record.surface === "string" ? record.surface : undefined,
        transport: typeof record.transport === "string" ? record.transport : undefined,
      };
    case "diagnostic.phase.completed":
      return {
        ...base,
        kind: "phase",
        durationMs,
        phaseName: typeof record.phase === "string" ? record.phase : undefined,
        outcome: "completed",
      };
    case "run.completed":
    case "harness.run.completed":
    case "harness.run.error":
      return {
        ...base,
        kind: "run",
        durationMs,
        outcome:
          type.endsWith("error") || record.outcome === "error"
            ? "error"
            : typeof record.outcome === "string"
              ? record.outcome
              : "completed",
        provider: typeof record.provider === "string" ? record.provider : undefined,
        model: typeof record.model === "string" ? record.model : undefined,
        extensionId: typeof record.pluginId === "string" ? record.pluginId : undefined,
        harnessId: typeof record.source === "string" ? record.source : undefined,
      };
    case "run.started":
      return {
        ...base,
        kind: "run",
        outcome: "started",
        provider: typeof record.provider === "string" ? record.provider : undefined,
        model: typeof record.model === "string" ? record.model : undefined,
      };
    default:
      return undefined;
  }
}

/**
 * @param {Array<{ kind: "run_window"; runId: string; startedAt?: number; endedAt?: number; sessionKey?: string; sessionId?: string; provider?: string; model?: string; outcome?: string }>} windows
 * @returns {Map<string, RunWindow>}
 */
export function mergeRunWindows(windows) {
  /** @type {Map<string, RunWindow>} */
  const map = new Map();
  for (const patch of windows) {
    const existing = map.get(patch.runId) ?? {
      runId: patch.runId,
      startedAt: patch.startedAt ?? 0,
    };
    map.set(patch.runId, {
      runId: patch.runId,
      startedAt: Math.min(
        existing.startedAt || Number.POSITIVE_INFINITY,
        patch.startedAt ?? existing.startedAt ?? Number.POSITIVE_INFINITY,
      ),
      endedAt: Math.max(existing.endedAt ?? 0, patch.endedAt ?? 0) || undefined,
      sessionKey: patch.sessionKey ?? existing.sessionKey,
      sessionId: patch.sessionId ?? existing.sessionId,
      provider: patch.provider ?? existing.provider,
      model: patch.model ?? existing.model,
      outcome: patch.outcome ?? existing.outcome,
    });
  }
  for (const run of map.values()) {
    if (!Number.isFinite(run.startedAt) || run.startedAt === Number.POSITIVE_INFINITY) {
      run.startedAt = run.endedAt ?? 0;
    }
  }
  return map;
}

/**
 * @param {TimingRow} row
 * @param {Map<string, RunWindow>} runs
 * @returns {TimingRow | undefined}
 */
export function correlateStabilityRow(row, runs) {
  if (row.source !== "stability" || row.runId) {
    return row.runId ? row : undefined;
  }
  const candidates = [...runs.values()].filter((run) => {
    const start = run.startedAt ?? 0;
    const end = run.endedAt ?? start + 30 * 60_000;
    return row.at >= start - 2_000 && row.at <= end + 2_000;
  });
  if (candidates.length === 0) {
    return undefined;
  }
  candidates.sort((left, right) => {
    const leftDist = Math.abs(row.at - (left.startedAt ?? row.at));
    const rightDist = Math.abs(row.at - (right.startedAt ?? row.at));
    return leftDist - rightDist;
  });
  const best = candidates[0];
  return {
    ...row,
    runId: best.runId,
    sessionKey: row.sessionKey ?? best.sessionKey,
    sessionId: row.sessionId ?? best.sessionId,
    provider: row.provider ?? best.provider,
    model: row.model ?? best.model,
    correlation: "time-window",
  };
}

function listLogFiles(logsDir, explicitPaths) {
  if (explicitPaths.length > 0) {
    return explicitPaths;
  }
  if (!fs.existsSync(logsDir)) {
    return [];
  }
  return fs
    .readdirSync(logsDir)
    .filter((name) => /^openclaw(-\d{4}-\d{2}-\d{2})?\.log$/u.test(name))
    .map((name) => path.join(logsDir, name))
    .toSorted();
}

function listStabilityBundles(stabilityDir, explicitPaths) {
  if (explicitPaths.length > 0) {
    return explicitPaths;
  }
  if (!fs.existsSync(stabilityDir)) {
    return [];
  }
  return fs
    .readdirSync(stabilityDir)
    .filter((name) => name.startsWith("openclaw-stability-") && name.endsWith(".json"))
    .map((name) => path.join(stabilityDir, name))
    .toSorted();
}

function readLinesFromFile(filePath) {
  return fs.readFileSync(filePath, "utf8").split("\n");
}

function readStabilityRecords(bundlePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
    const records = parsed?.snapshot?.records;
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

/** @typedef {{ query: number; at: number; traceId?: string; spanId?: string; reply: string }} ReplyMarker */

/**
 * @param {string[]} logPaths
 * @returns {Map<number, ReplyMarker>}
 */
export function indexReplyMarkersFromLogs(logPaths) {
  /** @type {Map<number, ReplyMarker>} */
  const markers = new Map();
  const replyRe = /^ok-(\d+)$/u;
  for (const file of logPaths) {
    for (const line of readLinesFromFile(file)) {
      const record = parseOpenClawLogLine(line);
      if (!record?.message) {
        continue;
      }
      const match = record.message.match(replyRe);
      if (!match) {
        continue;
      }
      const query = Number(match[1]);
      if (!Number.isFinite(query)) {
        continue;
      }
      const raw = record.raw;
      markers.set(query, {
        query,
        at: record.time ?? Date.now(),
        traceId: typeof raw.traceId === "string" ? raw.traceId : undefined,
        spanId: typeof raw.spanId === "string" ? raw.spanId : undefined,
        reply: record.message,
      });
    }
  }
  return markers;
}

/**
 * @param {string[]} logPaths
 * @param {string} traceId
 * @returns {TimingRow[]}
 */
export function extractTraceScopedLogEvents(logPaths, traceId) {
  /** @type {TimingRow[]} */
  const rows = [];
  for (const file of logPaths) {
    for (const line of readLinesFromFile(file)) {
      const record = parseOpenClawLogLine(line);
      if (!record || record.raw.traceId !== traceId) {
        continue;
      }
      const message = record.message ?? "";
      if (message.includes("tool policy removed")) {
        rows.push({
          runId: "",
          kind: "phase",
          at: record.time ?? Date.now(),
          phaseName: "agents/tool-policy",
          outcome: "completed",
          source: "log",
          logMessage: message.slice(0, 240),
          correlation: "traceId",
        });
      }
      if (message.includes("agent runtime plugins pre-warmed in")) {
        const msMatch = message.match(/pre-warmed in (\d+)ms/u);
        rows.push({
          runId: "",
          kind: "phase",
          at: record.time ?? Date.now(),
          durationMs: msMatch ? roundMs(Number(msMatch[1])) : undefined,
          phaseName: "gateway/plugins.pre-warm",
          outcome: "completed",
          source: "log",
          logMessage: message,
          correlation: "traceId",
        });
      }
    }
  }
  return rows;
}

/**
 * @param {string} filePath
 * @param {Map<number, ReplyMarker>} replyMarkers
 * @param {string[]} logPaths
 */
export function ingestAgentResults(filePath, replyMarkers, logPaths) {
  /** @type {Array<{ kind: "run_window"; runId: string; startedAt?: number; endedAt?: number; sessionKey?: string; sessionId?: string; provider?: string; model?: string; outcome?: string }>} */
  const windowPatches = [];
  /** @type {TimingRow[]} */
  const timingRows = [];

  for (const line of readLinesFromFile(filePath)) {
    if (!line.trim()) {
      continue;
    }
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row?.runId) {
      continue;
    }
    const marker = replyMarkers.get(row.query);
    const endedAt = marker?.at ?? Date.now();
    const agentDuration =
      typeof row.durationMs === "number" && Number.isFinite(row.durationMs)
        ? row.durationMs
        : undefined;
    const wallMs =
      typeof row.wallMs === "number" && Number.isFinite(row.wallMs) ? row.wallMs : undefined;
    const startedAt =
      agentDuration !== undefined
        ? endedAt - agentDuration
        : wallMs !== undefined
          ? endedAt - wallMs
          : endedAt - 1;

    windowPatches.push({
      kind: "run_window",
      runId: row.runId,
      startedAt,
      endedAt,
      sessionKey: row.sessionKey,
      sessionId: row.sessionId,
      provider: row.provider,
      model: row.model,
      outcome: row.status === "ok" ? "completed" : row.status,
    });

    timingRows.push({
      runId: row.runId,
      sessionKey: row.sessionKey,
      sessionId: row.sessionId,
      kind: "run",
      at: endedAt,
      durationMs: wallMs,
      outcome: row.status === "ok" ? "completed" : row.status,
      phaseName: "agent.turn.wall",
      source: "agent-jsonl",
      correlation: marker ? "reply-marker" : "agent-jsonl",
    });

    if (agentDuration !== undefined) {
      timingRows.push({
        runId: row.runId,
        sessionKey: row.sessionKey,
        sessionId: row.sessionId,
        kind: "llm",
        at: endedAt,
        durationMs: agentDuration,
        outcome: row.status === "ok" ? "completed" : row.status,
        provider: row.provider,
        model: row.model,
        handlerRef: row.provider && row.model ? `provider:${row.provider}/${row.model}` : undefined,
        phaseName: "agent.meta.durationMs",
        source: "agent-jsonl",
        correlation: "agent-jsonl",
      });
    }

    if (marker?.traceId) {
      for (const traceEvent of extractTraceScopedLogEvents(logPaths, marker.traceId)) {
        timingRows.push({
          ...traceEvent,
          runId: row.runId,
          sessionKey: row.sessionKey,
          sessionId: row.sessionId,
        });
      }
    }
  }

  return { windowPatches, timingRows };
}

/**
 * @param {Object} params
 * @param {string[]} [params.logPaths]
 * @param {string[]} [params.stabilityPaths]
 * @param {string} [params.logsDir]
 * @param {string} [params.stabilityDir]
 * @param {string} [params.runIdFilter]
 * @param {boolean} [params.includeStability]
 * @param {string[]} [params.agentJsonlPaths]
 * @param {string[]} [params.monitorTracePaths]
 */
export function aggregateRunTiming(params = {}) {
  const defaults = resolveDefaultLogPaths();
  const logsDir = params.logsDir ?? defaults.logsDir;
  const stabilityDir = params.stabilityDir ?? defaults.stabilityDir;
  const logPaths = listLogFiles(logsDir, params.logPaths ?? []);
  const includeStability = params.includeStability !== false;
  const stabilityPaths = includeStability
    ? listStabilityBundles(stabilityDir, params.stabilityPaths ?? [])
    : [];
  const replyMarkers = indexReplyMarkersFromLogs(logPaths);

  /** @type {Array<{ kind: "run_window"; runId: string; startedAt?: number; endedAt?: number; sessionKey?: string; sessionId?: string; provider?: string; model?: string; outcome?: string }>} */
  const windowPatches = [];
  /** @type {TimingRow[]} */
  const timingRows = [];

  for (const agentJsonlPath of params.agentJsonlPaths ?? []) {
    if (!agentJsonlPath || !fs.existsSync(agentJsonlPath)) {
      continue;
    }
    const ingested = ingestAgentResults(agentJsonlPath, replyMarkers, logPaths);
    windowPatches.push(...ingested.windowPatches);
    timingRows.push(...ingested.timingRows);
  }

  for (const monitorTracePath of params.monitorTracePaths ?? []) {
    if (!monitorTracePath || !fs.existsSync(monitorTracePath)) {
      continue;
    }
    const ingested = ingestMonitorTraces(monitorTracePath);
    windowPatches.push(...ingested.windowPatches);
    timingRows.push(...ingested.timingRows);
  }

  for (const file of logPaths) {
    for (const line of readLinesFromFile(file)) {
      const record = parseOpenClawLogLine(line);
      if (!record) {
        continue;
      }
      for (const event of extractEventsFromLogRecord(record)) {
        if (event.kind === "run_window") {
          windowPatches.push(event);
        } else {
          timingRows.push(event);
        }
      }
    }
  }

  const runs = mergeRunWindows(windowPatches);

  if (includeStability) {
    for (const bundlePath of stabilityPaths) {
      for (const record of readStabilityRecords(bundlePath)) {
        const row = stabilityRecordToTimingRow(record);
        if (!row) {
          continue;
        }
        const correlated = correlateStabilityRow(row, runs);
        if (correlated) {
          timingRows.push(correlated);
        }
      }
    }
  }

  timingRows.sort((left, right) => {
    if (left.runId !== right.runId) {
      return left.runId.localeCompare(right.runId);
    }
    if (left.at !== right.at) {
      return left.at - right.at;
    }
    return `${left.kind}:${left.phaseName ?? ""}`.localeCompare(
      `${right.kind}:${right.phaseName ?? ""}`,
    );
  });

  const filteredRows = params.runIdFilter
    ? timingRows.filter((row) => row.runId === params.runIdFilter)
    : timingRows;

  const agentRunIds =
    params.agentJsonlPaths?.length && !params.runIdFilter
      ? new Set(filteredRows.filter((row) => row.source === "agent-jsonl").map((row) => row.runId))
      : undefined;

  const monitorRunIds =
    params.monitorTracePaths?.length && !params.runIdFilter
      ? new Set(
          filteredRows
            .filter((row) => row.source === "performance-monitor")
            .map((row) => row.runId),
        )
      : undefined;

  const filteredRuns = [...runs.values()].filter((run) => {
    if (params.runIdFilter) {
      return run.runId === params.runIdFilter;
    }
    if (monitorRunIds?.size) {
      return monitorRunIds.has(run.runId);
    }
    if (agentRunIds?.size) {
      return agentRunIds.has(run.runId);
    }
    return true;
  });

  const activeRunIds = new Set(filteredRuns.map((run) => run.runId));

  return {
    runs: filteredRuns,
    events: filteredRows.filter((row) => activeRunIds.has(row.runId)),
  };
}

function parseHookHandlerIdentity(handlerRef, handlerSource) {
  const ref = handlerRef.trim();
  const identity = { handlerRef: ref };
  const at = ref.indexOf("@");
  if (at >= 0) {
    identity.handlerName = ref.slice(at + 1).trim() || undefined;
    return identity;
  }
  const hash = ref.indexOf("#");
  if (hash >= 0) {
    identity.handlerSource = ref.slice(hash + 1).trim() || undefined;
    return identity;
  }
  if (handlerSource?.trim()) {
    identity.handlerSource = handlerSource.trim();
  }
  return identity;
}

function formatHookHandlerLabel(row) {
  const plugin = row.extensionId?.trim() || "unknown";
  const hook = row.hookName?.trim() || "hook";
  if (row.handlerName?.trim()) {
    return `${plugin} → ${hook} → ${row.handlerName.trim()}`;
  }
  if (row.handlerRef?.trim()) {
    return row.handlerRef.trim();
  }
  if (row.handlerSource?.trim()) {
    return `${plugin} → ${hook} (#${row.handlerSource.trim()})`;
  }
  return `${plugin} → ${hook}`;
}

function formatToolLabel(row) {
  const plugin = row.extensionId?.trim();
  const tool = row.toolName?.trim() || row.mcpToolName?.trim();
  if (plugin && tool) {
    return `${plugin} → ${tool}`;
  }
  if (tool) {
    return tool;
  }
  return row.handlerRef ?? row.handlerName ?? "tool";
}

function formatEventToken(row) {
  return formatEventLabel(row);
}

function formatEventLabel(row) {
  if (row.kind === "hook_handler") {
    return formatHookHandlerLabel(row);
  }
  if (row.kind === "tool") {
    return formatToolLabel(row);
  }
  if (row.kind === "llm") {
    return row.handlerRef ?? `${row.provider ?? "?"}/${row.model ?? "?"}`;
  }
  return row.handlerRef ?? row.phaseName ?? row.logMessage?.slice(0, 80) ?? row.kind;
}

function bumpBreakdownEntry(map, key, label, durationMs, outcome) {
  const existing = map.get(key);
  if (existing) {
    existing.count += 1;
    existing.totalMs = roundMs(existing.totalMs + durationMs);
    existing.avgMs = roundMs(existing.totalMs / existing.count);
    existing.maxMs = roundMs(Math.max(existing.maxMs, durationMs));
    if (outcome === "error") {
      existing.errorCount = (existing.errorCount ?? 0) + 1;
    }
    return;
  }
  map.set(key, {
    key,
    label,
    count: 1,
    totalMs: roundMs(durationMs),
    avgMs: roundMs(durationMs),
    maxMs: roundMs(durationMs),
    ...(outcome === "error" ? { errorCount: 1 } : {}),
  });
}

/**
 * @param {TimingRow[]} events
 */
function buildBreakdownSections(events) {
  /** @type {Map<string, any>} */
  const hookHandlers = new Map();
  /** @type {Map<string, any>} */
  const tools = new Map();
  /** @type {Map<string, any>} */
  const llmCalls = new Map();
  /** @type {Map<string, any>} */
  const phases = new Map();

  for (const event of events) {
    const durationMs = event.durationMs ?? 0;
    if (durationMs <= 0 && event.kind !== "phase") {
      continue;
    }
    switch (event.kind) {
      case "hook_handler": {
        const plugin = event.extensionId?.trim() || "unknown";
        const hook = event.hookName?.trim() || "hook";
        const key = event.handlerRef?.trim() || `hook:${plugin}:${hook}`;
        const label = formatHookHandlerLabel(event);
        bumpBreakdownEntry(hookHandlers, key, label, durationMs, event.outcome);
        break;
      }
      case "tool": {
        const plugin = event.extensionId?.trim();
        const tool = event.toolName?.trim() || event.mcpToolName?.trim();
        const key =
          event.handlerRef?.trim() ||
          (plugin && tool ? `tool:${plugin}:${tool}` : `tool:${tool || "unknown"}`);
        const label = formatToolLabel(event);
        bumpBreakdownEntry(tools, key, label, durationMs, event.outcome);
        break;
      }
      case "llm": {
        const key =
          event.handlerRef?.trim() ||
          `llm:${event.provider?.trim() || "unknown"}/${event.model?.trim() || "unknown"}`;
        const label =
          event.handlerRef?.trim() ||
          `${event.provider?.trim() || "unknown"}/${event.model?.trim() || "unknown"}`;
        bumpBreakdownEntry(llmCalls, key, label, durationMs, event.outcome);
        break;
      }
      case "phase": {
        const key = event.phaseName?.trim() || "phase";
        bumpBreakdownEntry(phases, key, key, durationMs, event.outcome);
        break;
      }
      default:
        break;
    }
  }

  const sortEntries = (map) =>
    [...map.values()].sort(
      (left, right) => right.totalMs - left.totalMs || left.label.localeCompare(right.label),
    );

  return {
    hookHandlers: sortEntries(hookHandlers),
    tools: sortEntries(tools),
    llmCalls: sortEntries(llmCalls),
    phases: sortEntries(phases),
  };
}

/** @param {TimingRow} row */
function monitorEventToTimingRow(runMeta, row) {
  return {
    runId: runMeta.runId,
    sessionKey: runMeta.sessionKey,
    sessionId: runMeta.sessionId,
    kind: row.kind,
    at: row.at ?? runMeta.updatedAt ?? runMeta.startedAt ?? Date.now(),
    durationMs: row.durationMs,
    outcome: row.outcome,
    extensionId: row.extensionId,
    hookName: row.hookName,
    toolName: row.toolName,
    handlerName: row.handlerName,
    handlerSource: row.handlerSource,
    handlerRef: row.handlerRef,
    toolSource: row.toolSource,
    mcpServerName: row.mcpServerName,
    mcpToolName: row.mcpToolName,
    provider: row.provider,
    model: row.model,
    providerPluginId: row.providerPluginId,
    harnessId: row.harnessId,
    api: row.api,
    transport: row.transport,
    phaseName: row.phaseName,
    callId: row.callId,
    toolCallId: row.toolCallId,
    source: "performance-monitor",
    correlation: "monitor-trace",
  };
}

/**
 * @param {string} filePath
 */
export function ingestMonitorTraces(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  /** @type {Array<{ kind: "run_window"; runId: string; startedAt?: number; endedAt?: number; sessionKey?: string; sessionId?: string; provider?: string; model?: string; outcome?: string }>} */
  const windowPatches = [];
  /** @type {TimingRow[]} */
  const timingRows = [];

  const runs = Array.isArray(parsed?.runs) ? parsed.runs : parsed?.runId ? [parsed] : [];
  for (const run of runs) {
    if (!run?.runId) {
      continue;
    }
    windowPatches.push({
      kind: "run_window",
      runId: run.runId,
      startedAt: run.startedAt,
      endedAt: run.updatedAt ?? run.endedAt,
      sessionKey: run.sessionKey,
      sessionId: run.sessionId,
      outcome: run.outcome,
    });
    const events = Array.isArray(run.events) ? run.events : [];
    for (const event of events) {
      timingRows.push(
        monitorEventToTimingRow(
          {
            runId: run.runId,
            sessionKey: run.sessionKey,
            sessionId: run.sessionId,
            startedAt: run.startedAt,
            updatedAt: run.updatedAt,
          },
          event,
        ),
      );
    }
    const breakdown = run.breakdown;
    if (events.length === 0 && breakdown) {
      for (const [category, entries] of Object.entries(breakdown)) {
        if (!Array.isArray(entries)) {
          continue;
        }
        for (const entry of entries) {
          timingRows.push({
            runId: run.runId,
            sessionKey: run.sessionKey,
            sessionId: run.sessionId,
            kind:
              category === "hookHandlers"
                ? "hook_handler"
                : category === "llmCalls"
                  ? "llm"
                  : category === "tools"
                    ? "tool"
                    : "phase",
            at: run.updatedAt ?? run.startedAt ?? Date.now(),
            durationMs: entry.totalMs,
            handlerRef: entry.key,
            phaseName: category === "phases" ? entry.key : undefined,
            hookName: category === "hookHandlers" ? entry.label.split(" → ").pop() : undefined,
            extensionId: category === "hookHandlers" ? entry.label.split(" → ").shift() : undefined,
            source: "performance-monitor",
            correlation: "monitor-breakdown",
            metadata: { count: entry.count, avgMs: entry.avgMs, maxMs: entry.maxMs },
          });
        }
      }
    }
  }

  return { windowPatches, timingRows };
}

/**
 * @param {{ runs: RunWindow[], events: TimingRow[] }} aggregated
 */
export function formatEventsTsv(aggregated) {
  const columns = [
    "runId",
    "sessionKey",
    "sessionId",
    "at",
    "kind",
    "extensionId",
    "hookName",
    "toolName",
    "handlerName",
    "handlerSource",
    "handlerRef",
    "toolSource",
    "mcpServerName",
    "mcpToolName",
    "provider",
    "model",
    "providerPluginId",
    "harnessId",
    "api",
    "transport",
    "phaseName",
    "callId",
    "toolCallId",
    "durationMs",
    "outcome",
    "source",
    "correlation",
  ];
  const lines = [columns.join("\t")];
  for (const event of aggregated.events) {
    if (!event.runId) {
      continue;
    }
    lines.push(
      columns
        .map((column) => {
          const value = event[column];
          return value === undefined || value === null ? "" : String(value);
        })
        .join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {{ runs: RunWindow[], events: TimingRow[] }} aggregated
 */
export function formatBreakdownTsv(aggregated) {
  const columns = [
    "runId",
    "sessionKey",
    "sessionId",
    "category",
    "pluginId",
    "hookName",
    "handlerName",
    "handlerSource",
    "toolName",
    "handlerRef",
    "provider",
    "model",
    "label",
    "count",
    "totalMs",
    "avgMs",
    "maxMs",
    "errorCount",
  ];
  const lines = [columns.join("\t")];
  /** @type {Map<string, TimingRow[]>} */
  const byRun = new Map();
  for (const event of aggregated.events) {
    if (!event.runId) {
      continue;
    }
    const bucket = byRun.get(event.runId) ?? [];
    bucket.push(event);
    byRun.set(event.runId, bucket);
  }

  for (const run of aggregated.runs.toSorted((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
    const sections = buildBreakdownSections(byRun.get(run.runId) ?? []);
    /** @type {Array<[string, any[]]>} */
    const categories = [
      ["hook", sections.hookHandlers],
      ["tool", sections.tools],
      ["llm", sections.llmCalls],
      ["phase", sections.phases],
    ];
    for (const [category, entries] of categories) {
      for (const entry of entries) {
        const sample = (byRun.get(run.runId) ?? []).find((event) => {
          if (category === "hook") {
            return (
              event.kind === "hook_handler" &&
              (event.handlerRef === entry.key ||
                `${event.extensionId} → ${event.hookName}` === entry.label)
            );
          }
          if (category === "tool") {
            return (
              event.kind === "tool" &&
              (event.handlerRef === entry.key ||
                formatToolLabel(event) === entry.label ||
                event.toolName === entry.label)
            );
          }
          if (category === "llm") {
            return event.kind === "llm" && event.handlerRef === entry.key;
          }
          return event.kind === "phase" && event.phaseName === entry.key;
        });
        const pluginId =
          category === "hook"
            ? (sample?.extensionId ?? entry.label.split(" → ").shift())
            : (sample?.extensionId ?? "");
        const hookName =
          category === "hook" ? (sample?.hookName ?? entry.label.split(" → ").at(1)?.trim()) : "";
        const handlerName = category === "hook" ? (sample?.handlerName ?? "") : "";
        const handlerSource = category === "hook" ? (sample?.handlerSource ?? "") : "";
        lines.push(
          [
            run.runId,
            run.sessionKey ?? "",
            run.sessionId ?? "",
            category,
            pluginId ?? "",
            hookName ?? "",
            handlerName ?? "",
            handlerSource ?? "",
            category === "tool" ? (sample?.toolName ?? entry.label) : "",
            entry.key,
            category === "llm" ? (sample?.provider ?? "") : "",
            category === "llm" ? (sample?.model ?? "") : "",
            entry.label,
            entry.count,
            entry.totalMs,
            entry.avgMs,
            entry.maxMs,
            entry.errorCount ?? 0,
          ].join("\t"),
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {{ runs: RunWindow[], events: TimingRow[] }} aggregated
 */
export function formatRunSummaryTsv(aggregated) {
  /** @type {Map<string, TimingRow[]>} */
  const byRun = new Map();
  for (const event of aggregated.events) {
    if (!event.runId) {
      continue;
    }
    const bucket = byRun.get(event.runId) ?? [];
    bucket.push(event);
    byRun.set(event.runId, bucket);
  }

  const lines = [
    [
      "runId",
      "sessionKey",
      "sessionId",
      "startedAt",
      "endedAt",
      "eventCount",
      "hookMs",
      "toolMs",
      "llmMs",
      "phaseMs",
      "events",
    ].join("\t"),
  ];

  for (const run of aggregated.runs.toSorted((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
    const events = byRun.get(run.runId) ?? [];
    const totals = { hook: 0, tool: 0, llm: 0, phase: 0 };
    for (const event of events) {
      const ms = event.durationMs ?? 0;
      if (event.kind === "hook_handler") {
        totals.hook += ms;
      } else if (event.kind === "tool") {
        totals.tool += ms;
      } else if (event.kind === "llm") {
        totals.llm += ms;
      } else if (event.kind === "phase") {
        totals.phase += ms;
      }
    }
    lines.push(
      [
        run.runId,
        run.sessionKey ?? "",
        run.sessionId ?? "",
        run.startedAt ?? "",
        run.endedAt ?? "",
        events.length,
        roundMs(totals.hook),
        roundMs(totals.tool),
        roundMs(totals.llm),
        roundMs(totals.phase),
        events
          .map((row) => {
            const ms = row.durationMs !== undefined ? `${row.durationMs}ms` : "n/a";
            const outcome = row.outcome ? `/${row.outcome}` : "";
            return `${row.kind}:${formatEventLabel(row)}=${ms}${outcome}`;
          })
          .join(" | "),
      ].join("\t"),
    );
  }

  return `${lines.join("\n")}\n`;
}

export const testApi = {
  extractKeyValues,
  mergeRunWindows,
  correlateStabilityRow,
};
