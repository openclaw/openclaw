import crypto from "node:crypto";
import { clearSessionQueues } from "../auto-reply/reply/queue.js";
import {
  resolveSubagentLabel,
  resolveSubagentTargetFromRuns,
  sortSubagentRuns,
  type SubagentTargetResolution,
} from "../auto-reply/reply/subagents-utils.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { loadSessionStore, resolveStorePath, updateSessionStore } from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { logVerbose } from "../globals.js";
import {
  isSubagentSessionKey,
  parseAgentSessionKey,
  type ParsedAgentSessionKey,
} from "../routing/session-key.js";
import {
  formatDurationCompact,
  formatTokenUsageDisplay,
  resolveTotalTokens,
  truncateLine,
} from "../shared/subagents-format.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import { abortEmbeddedPiRun } from "./pi-embedded.js";
import { resolveStoredSubagentCapabilities } from "./subagent-capabilities.js";
import {
  clearSubagentRunSteerRestart,
  countPendingDescendantRuns,
  getSubagentRunByChildSessionKey,
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  listSubagentRunsForController,
  markSubagentRunTerminated,
  markSubagentRunForSteerRestart,
  replaceSubagentRunAfterSteer,
  type SubagentRunRecord,
} from "./subagent-registry.js";
import {
  extractAssistantText,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  stripToolMessages,
} from "./tools/sessions-helpers.js";

export const DEFAULT_RECENT_MINUTES = 30;
export const MAX_RECENT_MINUTES = 24 * 60;
export const MAX_STEER_MESSAGE_CHARS = 4_000;
export const STEER_RATE_LIMIT_MS = 2_000;
export const STEER_ABORT_SETTLE_TIMEOUT_MS = 5_000;

const steerRateLimit = new Map<string, number>();

type GatewayCaller = typeof callGateway;

const defaultSubagentControlDeps = {
  callGateway,
};

let subagentControlDeps: {
  callGateway: GatewayCaller;
} = defaultSubagentControlDeps;

export type SessionEntryResolution = {
  storePath: string;
  entry: SessionEntry | undefined;
};

export type ResolvedSubagentController = {
  controllerSessionKey: string;
  callerSessionKey: string;
  callerIsSubagent: boolean;
  controlScope: "children" | "none";
};

export type SubagentListItem = {
  index: number;
  line: string;
  runId: string;
  sessionKey: string;
  label: string;
  task: string;
  status: string;
  pendingDescendants: number;
  runtime: string;
  runtimeMs: number;
  childSessions?: string[];
  model?: string;
  totalTokens?: number;
  startedAt?: number;
  endedAt?: number;
};

export type BuiltSubagentList = {
  total: number;
  active: SubagentListItem[];
  recent: SubagentListItem[];
  text: string;
};

function resolveStorePathForKey(
  cfg: OpenClawConfig,
  key: string,
  parsed?: ParsedAgentSessionKey | null,
) {
  return resolveStorePath(cfg.session?.store, {
    agentId: parsed?.agentId,
  });
}

export function resolveSessionEntryForKey(params: {
  cfg: OpenClawConfig;
  key: string;
  cache: Map<string, Record<string, SessionEntry>>;
}): SessionEntryResolution {
  const parsed = parseAgentSessionKey(params.key);
  const storePath = resolveStorePathForKey(params.cfg, params.key, parsed);
  let store = params.cache.get(storePath);
  if (!store) {
    store = loadSessionStore(storePath);
    params.cache.set(storePath, store);
  }
  return {
    storePath,
    entry: store[params.key],
  };
}

export function resolveSubagentController(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
}): ResolvedSubagentController {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const callerRaw = params.agentSessionKey?.trim() || alias;
  const callerSessionKey = resolveInternalSessionKey({
    key: callerRaw,
    alias,
    mainKey,
  });
  if (!isSubagentSessionKey(callerSessionKey)) {
    return {
      controllerSessionKey: callerSessionKey,
      callerSessionKey,
      callerIsSubagent: false,
      controlScope: "children",
    };
  }
  const capabilities = resolveStoredSubagentCapabilities(callerSessionKey, {
    cfg: params.cfg,
  });
  return {
    controllerSessionKey: callerSessionKey,
    callerSessionKey,
    callerIsSubagent: true,
    controlScope: capabilities.controlScope,
  };
}

export function listControlledSubagentRuns(controllerSessionKey: string): SubagentRunRecord[] {
  return sortSubagentRuns(listSubagentRunsForController(controllerSessionKey));
}

export function createPendingDescendantCounter() {
  const pendingDescendantCache = new Map<string, number>();
  return (sessionKey: string) => {
    if (pendingDescendantCache.has(sessionKey)) {
      return pendingDescendantCache.get(sessionKey) ?? 0;
    }
    const pending = Math.max(0, countPendingDescendantRuns(sessionKey));
    pendingDescendantCache.set(sessionKey, pending);
    return pending;
  };
}

export function isActiveSubagentRun(
  entry: SubagentRunRecord,
  pendingDescendantCount: (sessionKey: string) => number,
) {
  return !entry.endedAt || pendingDescendantCount(entry.childSessionKey) > 0;
}

function resolveRunStatus(entry: SubagentRunRecord, options?: { pendingDescendants?: number }) {
  const pendingDescendants = Math.max(0, options?.pendingDescendants ?? 0);
  if (pendingDescendants > 0) {
    const childLabel = pendingDescendants === 1 ? "child" : "children";
    return `active (waiting on ${pendingDescendants} ${childLabel})`;
  }
  if (!entry.endedAt) {
    return "running";
  }
  const status = entry.outcome?.status ?? "done";
  if (status === "ok") {
    return "done";
  }
  if (status === "error") {
    return "failed";
  }
  return status;
}

function resolveModelRef(entry?: SessionEntry) {
  const model = typeof entry?.model === "string" ? entry.model.trim() : "";
  const provider = typeof entry?.modelProvider === "string" ? entry.modelProvider.trim() : "";
  if (model.includes("/")) {
    return model;
  }
  if (model && provider) {
    return `${provider}/${model}`;
  }
  if (model) {
    return model;
  }
  if (provider) {
    return provider;
  }
  const overrideModel = typeof entry?.modelOverride === "string" ? entry.modelOverride.trim() : "";
  const overrideProvider =
    typeof entry?.providerOverride === "string" ? entry.providerOverride.trim() : "";
  if (overrideModel.includes("/")) {
    return overrideModel;
  }
  if (overrideModel && overrideProvider) {
    return `${overrideProvider}/${overrideModel}`;
  }
  if (overrideModel) {
    return overrideModel;
  }
  return overrideProvider || undefined;
}

function resolveModelDisplay(entry?: SessionEntry, fallbackModel?: string) {
  const modelRef = resolveModelRef(entry) || fallbackModel || undefined;
  if (!modelRef) {
    return "model n/a";
  }
  const slash = modelRef.lastIndexOf("/");
  if (slash >= 0 && slash < modelRef.length - 1) {
    return modelRef.slice(slash + 1);
  }
  return modelRef;
}

function buildListText(params: {
  active: Array<{ line: string }>;
  recent: Array<{ line: string }>;
  recentMinutes: number;
}) {
  const lines: string[] = [];
  lines.push("active subagents:");
  if (params.active.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(...params.active.map((entry) => entry.line));
  }
  lines.push("");
  lines.push(`recent (last ${params.recentMinutes}m):`);
  if (params.recent.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(...params.recent.map((entry) => entry.line));
  }
  return lines.join("\n");
}

export function buildSubagentList(params: {
  cfg: OpenClawConfig;
  runs: SubagentRunRecord[];
  recentMinutes: number;
  taskMaxChars?: number;
}): BuiltSubagentList {
  const now = Date.now();
  const recentCutoff = now - params.recentMinutes * 60_000;
  const cache = new Map<string, Record<string, SessionEntry>>();
  const pendingDescendantCount = createPendingDescendantCounter();
  let index = 1;
  const buildListEntry = (entry: SubagentRunRecord, runtimeMs: number) => {
    const sessionEntry = resolveSessionEntryForKey({
      cfg: params.cfg,
      key: entry.childSessionKey,
      cache,
    }).entry;
    const totalTokens = resolveTotalTokens(sessionEntry);
    const usageText = formatTokenUsageDisplay(sessionEntry);
    const pendingDescendants = pendingDescendantCount(entry.childSessionKey);
    const status = resolveRunStatus(entry, {
      pendingDescendants,
    });
    const childSessions = Array.from(
      new Set(
        listSubagentRunsForController(entry.childSessionKey).map((run) => run.childSessionKey),
      ),
    );
    const runtime = formatDurationCompact(runtimeMs);
    const label = truncateLine(resolveSubagentLabel(entry), 48);
    const task = truncateLine(entry.task.trim(), params.taskMaxChars ?? 72);
    const line = `${index}. ${label} (${resolveModelDisplay(sessionEntry, entry.model)}, ${runtime}${usageText ? `, ${usageText}` : ""}) ${status}${task.toLowerCase() !== label.toLowerCase() ? ` - ${task}` : ""}`;
    const view: SubagentListItem = {
      index,
      line,
      runId: entry.runId,
      sessionKey: entry.childSessionKey,
      label,
      task,
      status,
      pendingDescendants,
      runtime,
      runtimeMs,
      ...(childSessions.length > 0 ? { childSessions } : {}),
      model: resolveModelRef(sessionEntry) || entry.model,
      totalTokens,
      startedAt: getSubagentSessionStartedAt(entry),
      ...(entry.endedAt ? { endedAt: entry.endedAt } : {}),
    };
    index += 1;
    return view;
  };
  const active = params.runs
    .filter((entry) => isActiveSubagentRun(entry, pendingDescendantCount))
    .map((entry) => buildListEntry(entry, getSubagentSessionRuntimeMs(entry, now) ?? 0));
  const recent = params.runs
    .filter(
      (entry) =>
        !isActiveSubagentRun(entry, pendingDescendantCount) &&
        !!entry.endedAt &&
        (entry.endedAt ?? 0) >= recentCutoff,
    )
    .map((entry) =>
      buildListEntry(entry, getSubagentSessionRuntimeMs(entry, entry.endedAt ?? now) ?? 0),
    );
  return {
    total: params.runs.length,
    active,
    recent,
    text: buildListText({ active, recent, recentMinutes: params.recentMinutes }),
  };
}

function ensureControllerOwnsRun(params: {
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
}) {
  const owner = params.entry.controllerSessionKey?.trim() || params.entry.requesterSessionKey;
  if (owner === params.controller.controllerSessionKey) {
    return undefined;
  }
  return "Subagents can only control runs spawned from their own session.";
}

async function killSubagentRun(params: {
  cfg: OpenClawConfig;
  entry: SubagentRunRecord;
  cache: Map<string, Record<string, SessionEntry>>;
}): Promise<{ killed: boolean; sessionId?: string }> {
  if (params.entry.endedAt) {
    return { killed: false };
  }
  const childSessionKey = params.entry.childSessionKey;
  const resolved = resolveSessionEntryForKey({
    cfg: params.cfg,
    key: childSessionKey,
    cache: params.cache,
  });
  const sessionId = resolved.entry?.sessionId;
  const aborted = sessionId ? abortEmbeddedPiRun(sessionId) : false;
  const cleared = clearSessionQueues([childSessionKey, sessionId]);
  if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
    logVerbose(
      `subagents control kill: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
    );
  }
  if (resolved.entry) {
    try {
      await updateSessionStore(resolved.storePath, (store) => {
        const current = store[childSessionKey];
        if (!current) {
          return;
        }
        current.abortedLastRun = true;
        current.updatedAt = Date.now();
        store[childSessionKey] = current;
      });
    } catch (error) {
      logVerbose(
        `subagents control kill: failed to persist abortedLastRun for ${childSessionKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const marked = markSubagentRunTerminated({
    runId: params.entry.runId,
    childSessionKey,
    reason: "killed",
  });
  const killed = marked > 0 || aborted || cleared.followupCleared > 0 || cleared.laneCleared > 0;
  return { killed, sessionId };
}

async function cascadeKillChildren(params: {
  cfg: OpenClawConfig;
  parentChildSessionKey: string;
  cache: Map<string, Record<string, SessionEntry>>;
  seenChildSessionKeys?: Set<string>;
}): Promise<{ killed: number; labels: string[] }> {
  const childRuns = listSubagentRunsForController(params.parentChildSessionKey);
  const seenChildSessionKeys = params.seenChildSessionKeys ?? new Set<string>();
  let killed = 0;
  const labels: string[] = [];

  for (const run of childRuns) {
    const childKey = run.childSessionKey?.trim();
    if (!childKey || seenChildSessionKeys.has(childKey)) {
      continue;
    }
    seenChildSessionKeys.add(childKey);

    if (!run.endedAt) {
      const stopResult = await killSubagentRun({
        cfg: params.cfg,
        entry: run,
        cache: params.cache,
      });
      if (stopResult.killed) {
        killed += 1;
        labels.push(resolveSubagentLabel(run));
      }
    }

    const cascade = await cascadeKillChildren({
      cfg: params.cfg,
      parentChildSessionKey: childKey,
      cache: params.cache,
      seenChildSessionKeys,
    });
    killed += cascade.killed;
    labels.push(...cascade.labels);
  }

  return { killed, labels };
}

export async function killAllControlledSubagentRuns(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  runs: SubagentRunRecord[];
}) {
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden" as const,
      error: "Leaf subagents cannot control other sessions.",
      killed: 0,
      labels: [],
    };
  }
  const cache = new Map<string, Record<string, SessionEntry>>();
  const seenChildSessionKeys = new Set<string>();
  const killedLabels: string[] = [];
  let killed = 0;
  for (const entry of params.runs) {
    const childKey = entry.childSessionKey?.trim();
    if (!childKey || seenChildSessionKeys.has(childKey)) {
      continue;
    }
    seenChildSessionKeys.add(childKey);

    if (!entry.endedAt) {
      const stopResult = await killSubagentRun({ cfg: params.cfg, entry, cache });
      if (stopResult.killed) {
        killed += 1;
        killedLabels.push(resolveSubagentLabel(entry));
      }
    }

    const cascade = await cascadeKillChildren({
      cfg: params.cfg,
      parentChildSessionKey: childKey,
      cache,
      seenChildSessionKeys,
    });
    killed += cascade.killed;
    killedLabels.push(...cascade.labels);
  }
  return { status: "ok" as const, killed, labels: killedLabels };
}

export async function killControlledSubagentRun(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
}) {
  const ownershipError = ensureControllerOwnsRun({
    controller: params.controller,
    entry: params.entry,
  });
  if (ownershipError) {
    return {
      status: "forbidden" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: ownershipError,
    };
  }
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Leaf subagents cannot control other sessions.",
    };
  }
  const killCache = new Map<string, Record<string, SessionEntry>>();
  const stopResult = await killSubagentRun({
    cfg: params.cfg,
    entry: params.entry,
    cache: killCache,
  });
  const seenChildSessionKeys = new Set<string>();
  const targetChildKey = params.entry.childSessionKey?.trim();
  if (targetChildKey) {
    seenChildSessionKeys.add(targetChildKey);
  }
  const cascade = await cascadeKillChildren({
    cfg: params.cfg,
    parentChildSessionKey: params.entry.childSessionKey,
    cache: killCache,
    seenChildSessionKeys,
  });
  if (!stopResult.killed && cascade.killed === 0) {
    return {
      status: "done" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      label: resolveSubagentLabel(params.entry),
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  const cascadeText =
    cascade.killed > 0 ? ` (+ ${cascade.killed} descendant${cascade.killed === 1 ? "" : "s"})` : "";
  return {
    status: "ok" as const,
    runId: params.entry.runId,
    sessionKey: params.entry.childSessionKey,
    label: resolveSubagentLabel(params.entry),
    cascadeKilled: cascade.killed,
    cascadeLabels: cascade.killed > 0 ? cascade.labels : undefined,
    text: stopResult.killed
      ? `killed ${resolveSubagentLabel(params.entry)}${cascadeText}.`
      : `killed ${cascade.killed} descendant${cascade.killed === 1 ? "" : "s"} of ${resolveSubagentLabel(params.entry)}.`,
  };
}

export async function killSubagentRunAdmin(params: { cfg: OpenClawConfig; sessionKey: string }) {
  const targetSessionKey = params.sessionKey.trim();
  if (!targetSessionKey) {
    return { found: false as const, killed: false };
  }
  const entry = getSubagentRunByChildSessionKey(targetSessionKey);
  if (!entry) {
    return { found: false as const, killed: false };
  }

  const killCache = new Map<string, Record<string, SessionEntry>>();
  const stopResult = await killSubagentRun({
    cfg: params.cfg,
    entry,
    cache: killCache,
  });
  const seenChildSessionKeys = new Set<string>([targetSessionKey]);
  const cascade = await cascadeKillChildren({
    cfg: params.cfg,
    parentChildSessionKey: targetSessionKey,
    cache: killCache,
    seenChildSessionKeys,
  });

  return {
    found: true as const,
    killed: stopResult.killed || cascade.killed > 0,
    runId: entry.runId,
    sessionKey: entry.childSessionKey,
    cascadeKilled: cascade.killed,
    cascadeLabels: cascade.killed > 0 ? cascade.labels : undefined,
  };
}

export async function steerControlledSubagentRun(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
  message: string;
}): Promise<
  | {
      status: "forbidden" | "done" | "rate_limited" | "error";
      runId?: string;
      sessionKey: string;
      sessionId?: string;
      error?: string;
      text?: string;
    }
  | {
      status: "accepted";
      runId: string;
      sessionKey: string;
      sessionId?: string;
      mode: "restart";
      label: string;
      text: string;
    }
> {
  const ownershipError = ensureControllerOwnsRun({
    controller: params.controller,
    entry: params.entry,
  });
  if (ownershipError) {
    return {
      status: "forbidden",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: ownershipError,
    };
  }
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Leaf subagents cannot control other sessions.",
    };
  }
  if (params.entry.endedAt) {
    return {
      status: "done",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  if (params.controller.callerSessionKey === params.entry.childSessionKey) {
    return {
      status: "forbidden",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Subagents cannot steer themselves.",
    };
  }

  const rateKey = `${params.controller.callerSessionKey}:${params.entry.childSessionKey}`;
  if (process.env.VITEST !== "true") {
    const now = Date.now();
    const lastSentAt = steerRateLimit.get(rateKey) ?? 0;
    if (now - lastSentAt < STEER_RATE_LIMIT_MS) {
      return {
        status: "rate_limited",
        runId: params.entry.runId,
        sessionKey: params.entry.childSessionKey,
        error: "Steer rate limit exceeded. Wait a moment before sending another steer.",
      };
    }
    steerRateLimit.set(rateKey, now);
  }

  markSubagentRunForSteerRestart(params.entry.runId);

  const targetSession = resolveSessionEntryForKey({
    cfg: params.cfg,
    key: params.entry.childSessionKey,
    cache: new Map<string, Record<string, SessionEntry>>(),
  });
  const sessionId =
    typeof targetSession.entry?.sessionId === "string" && targetSession.entry.sessionId.trim()
      ? targetSession.entry.sessionId.trim()
      : undefined;

  if (sessionId) {
    abortEmbeddedPiRun(sessionId);
  }
  const cleared = clearSessionQueues([params.entry.childSessionKey, sessionId]);
  if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
    logVerbose(
      `subagents control steer: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
    );
  }

  try {
    await subagentControlDeps.callGateway({
      method: "agent.wait",
      params: {
        runId: params.entry.runId,
        timeoutMs: STEER_ABORT_SETTLE_TIMEOUT_MS,
      },
      timeoutMs: STEER_ABORT_SETTLE_TIMEOUT_MS + 2_000,
    });
  } catch {
    // Continue even if wait fails; steer should still be attempted.
  }

  const idempotencyKey = crypto.randomUUID();
  let runId: string = idempotencyKey;
  try {
    const response = await subagentControlDeps.callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: params.message,
        sessionKey: params.entry.childSessionKey,
        sessionId,
        idempotencyKey,
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_SUBAGENT,
        timeout: 0,
      },
      timeoutMs: 10_000,
    });
    if (typeof response?.runId === "string" && response.runId) {
      runId = response.runId;
    }
  } catch (err) {
    clearSubagentRunSteerRestart(params.entry.runId);
    const error = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      runId,
      sessionKey: params.entry.childSessionKey,
      sessionId,
      error,
    };
  }

  replaceSubagentRunAfterSteer({
    previousRunId: params.entry.runId,
    nextRunId: runId,
    fallback: params.entry,
    runTimeoutSeconds: params.entry.runTimeoutSeconds ?? 0,
  });

  return {
    status: "accepted",
    runId,
    sessionKey: params.entry.childSessionKey,
    sessionId,
    mode: "restart",
    label: resolveSubagentLabel(params.entry),
    text: `steered ${resolveSubagentLabel(params.entry)}.`,
  };
}

export async function sendControlledSubagentMessage(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
  message: string;
}) {
  const ownershipError = ensureControllerOwnsRun({
    controller: params.controller,
    entry: params.entry,
  });
  if (ownershipError) {
    return { status: "forbidden" as const, error: ownershipError };
  }
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden" as const,
      error: "Leaf subagents cannot control other sessions.",
    };
  }

  const targetSessionKey = params.entry.childSessionKey;
  const parsed = parseAgentSessionKey(targetSessionKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: parsed?.agentId });
  const store = loadSessionStore(storePath);
  const targetSessionEntry = store[targetSessionKey];
  const targetSessionId =
    typeof targetSessionEntry?.sessionId === "string" && targetSessionEntry.sessionId.trim()
      ? targetSessionEntry.sessionId.trim()
      : undefined;

  const idempotencyKey = crypto.randomUUID();
  let runId: string = idempotencyKey;
  try {
    const response = await subagentControlDeps.callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: params.message,
        sessionKey: targetSessionKey,
        sessionId: targetSessionId,
        idempotencyKey,
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_SUBAGENT,
        timeout: 0,
      },
      timeoutMs: 10_000,
    });
    const responseRunId = typeof response?.runId === "string" ? response.runId : undefined;
    if (responseRunId) {
      runId = responseRunId;
    }

    const waitMs = 30_000;
    const wait = await subagentControlDeps.callGateway<{ status?: string; error?: string }>({
      method: "agent.wait",
      params: { runId, timeoutMs: waitMs },
      timeoutMs: waitMs + 2_000,
    });
    if (wait?.status === "timeout") {
      return { status: "timeout" as const, runId };
    }
    if (wait?.status === "error") {
      const waitError = typeof wait.error === "string" ? wait.error : "unknown error";
      return { status: "error" as const, runId, error: waitError };
    }

    const history = await subagentControlDeps.callGateway<{ messages: Array<unknown> }>({
      method: "chat.history",
      params: { sessionKey: targetSessionKey, limit: 50 },
    });
    const filtered = stripToolMessages(Array.isArray(history?.messages) ? history.messages : []);
    const last = filtered.length > 0 ? filtered[filtered.length - 1] : undefined;
    const replyText = last ? extractAssistantText(last) : undefined;
    return { status: "ok" as const, runId, replyText };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { status: "error" as const, runId, error };
  }
}

export function resolveControlledSubagentTarget(
  runs: SubagentRunRecord[],
  token: string | undefined,
  options?: { recentMinutes?: number; isActive?: (entry: SubagentRunRecord) => boolean },
): SubagentTargetResolution {
  return resolveSubagentTargetFromRuns({
    runs,
    token,
    recentWindowMinutes: options?.recentMinutes ?? DEFAULT_RECENT_MINUTES,
    label: (entry) => resolveSubagentLabel(entry),
    isActive: options?.isActive,
    errors: {
      missingTarget: "Missing subagent target.",
      invalidIndex: (value) => `Invalid subagent index: ${value}`,
      unknownSession: (value) => `Unknown subagent session: ${value}`,
      ambiguousLabel: (value) => `Ambiguous subagent label: ${value}`,
      ambiguousLabelPrefix: (value) => `Ambiguous subagent label prefix: ${value}`,
      ambiguousRunIdPrefix: (value) => `Ambiguous subagent run id prefix: ${value}`,
      unknownTarget: (value) => `Unknown subagent target: ${value}`,
    },
  });
}

export const __testing = {
  setDepsForTest(overrides?: Partial<{ callGateway: GatewayCaller }>) {
    subagentControlDeps = overrides
      ? {
          ...defaultSubagentControlDeps,
          ...overrides,
        }
      : defaultSubagentControlDeps;
  },
};
