/**
 * Subagent list builder.
 *
 * Combines live registry runs and persisted session metadata for sessions_list/subagents views.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveSubagentLabel } from "../../../auto-reply/reply/subagents-utils.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { listSessionEntriesReadOnly } from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatDurationCompact } from "../../../infra/format-time/format-duration.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import {
  formatTokenUsageDisplay,
  resolveTotalTokens,
  truncateLine,
} from "../../../shared/subagents-format.js";
import { resolveModelDisplayName, resolveModelDisplayRef } from "../../model-selection-display.js";
import {
  observeSubagentExecution,
  type SubagentExecutionObservation,
} from "./subagent-execution-observation.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { buildSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
} from "./subagent-registry-read.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import {
  getSubagentRunsSnapshotForSession,
  getSubagentSessionListRunsSnapshotForRead,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { shouldKeepSubagentRunChildLink } from "./subagent-run-liveness.js";
import { buildSubagentRunView } from "./subagent-run-view.js";
import { resolveSubagentDisplayStatus } from "./subagent-session-metrics.js";

type SubagentListItem = {
  index: number;
  line: string;
  runId: string;
  sessionKey: string;
  taskName?: string;
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
  execution: SubagentExecutionObservation;
  deliveryStatus?: NonNullable<SubagentRunRecord["delivery"]>["status"];
};

type BuiltSubagentList = {
  total: number;
  active: SubagentListItem[];
  recent: SubagentListItem[];
  text: string;
};

function loadSubagentSessionEntries(
  cfg: OpenClawConfig,
  runs: readonly SubagentRunRecord[],
): Map<string, SessionEntry> {
  const keysByStore = new Map<string, string[]>();
  for (const run of runs) {
    const storePath = resolveSessionStorePathCore(cfg.session?.store, {
      agentId: parseAgentSessionKey(run.childSessionKey)?.agentId,
    });
    const keys = keysByStore.get(storePath);
    if (keys) {
      keys.push(run.childSessionKey);
    } else {
      keysByStore.set(storePath, [run.childSessionKey]);
    }
  }
  const entries = new Map<string, SessionEntry>();
  for (const [storePath, sessionKeys] of keysByStore) {
    // The listing accessor validates the whole snapshot before selecting these rows.
    for (const { sessionKey, entry } of listSessionEntriesReadOnly({
      storePath,
      sessionKeys,
      clone: false,
      projection: "list",
    })) {
      entries.set(sessionKey, entry);
    }
  }
  return entries;
}

/** Build child-session indexes from the latest run associated with each child key. */
function buildLatestSubagentRunIndex(
  runs: Map<string, SubagentRunReadRecord>,
  options?: { now?: number },
) {
  const now = options?.now ?? Date.now();
  const readIndex = buildSubagentRunReadIndexFromRuns({
    runs,
    inMemoryRuns: subagentRuns.values(),
    now,
  });

  const childSessionsByController = new Map<string, string[]>();
  for (const [childSessionKey, entry] of readIndex.latestRunsByChildSessionKey) {
    const controllerSessionKey =
      entry.controllerSessionKey?.trim() || entry.requesterSessionKey?.trim();
    if (!controllerSessionKey) {
      continue;
    }
    if (
      !shouldKeepSubagentRunChildLink(entry, {
        activeDescendants: readIndex.countActiveDescendantRuns(childSessionKey),
        now,
      })
    ) {
      // Completed child links age out unless active descendants still depend on
      // the controller relationship.
      continue;
    }
    const existing = childSessionsByController.get(controllerSessionKey);
    if (existing) {
      existing.push(childSessionKey);
      continue;
    }
    childSessionsByController.set(controllerSessionKey, [childSessionKey]);
  }
  for (const [controllerSessionKey, childSessions] of childSessionsByController) {
    childSessionsByController.set(controllerSessionKey, childSessions.toSorted());
  }

  return {
    childSessionsByController,
    readIndex,
  };
}

function resolveModelRef(entry?: SessionEntry, fallbackModel?: string) {
  return resolveModelDisplayRef({
    runtimeProvider: entry?.modelProvider,
    runtimeModel: entry?.model,
    overrideProvider: entry?.providerOverride,
    overrideModel: entry?.modelOverride,
    fallbackModel,
  });
}

function resolveModelDisplay(entry?: SessionEntry, fallbackModel?: string) {
  return resolveModelDisplayName({
    runtimeProvider: entry?.modelProvider,
    runtimeModel: entry?.model,
    overrideProvider: entry?.providerOverride,
    overrideModel: entry?.modelOverride,
    fallbackModel,
  });
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

/** Build structured and text views for active and recent subagent runs. */
export function buildSubagentList(params: {
  cfg: OpenClawConfig;
  runs: SubagentRunRecord[];
  recentMinutes: number;
  taskMaxChars?: number;
  readSnapshot?: Map<string, SubagentRunReadRecord>;
}): BuiltSubagentList {
  const now = Date.now();
  const snapshot = params.readSnapshot ?? getSubagentSessionListRunsSnapshotForRead(subagentRuns);
  const { childSessionsByController, readIndex } = buildLatestSubagentRunIndex(snapshot);
  const pendingDescendantCount = (sessionKey: string) =>
    readIndex.countPendingDescendantRuns(sessionKey);
  const runView = buildSubagentRunView({
    runs: params.runs,
    recentMinutes: params.recentMinutes,
    countPendingDescendantRuns: pendingDescendantCount,
    now,
  });
  const sessionEntries = loadSubagentSessionEntries(params.cfg, [
    ...runView.active,
    ...runView.recent,
  ]);
  let index = 1;
  const buildListEntry = (entry: SubagentRunRecord, runtimeMs: number) => {
    const sessionEntry = sessionEntries.get(entry.childSessionKey);
    const totalTokens = resolveTotalTokens(sessionEntry);
    const usageText = formatTokenUsageDisplay(sessionEntry);
    const pendingDescendants = pendingDescendantCount(entry.childSessionKey);
    const execution = observeSubagentExecution(
      entry,
      entry.pauseReason === "sessions_yield"
        ? getSubagentRunsSnapshotForSession(subagentRuns, entry.childSessionKey).values()
        : [],
    );
    const status = resolveSubagentDisplayStatus(
      entry,
      execution.state === "waiting" ? (execution.wait?.pendingCount ?? 0) : pendingDescendants,
    );
    const childSessions = childSessionsByController.get(entry.childSessionKey) ?? [];
    const runtime = formatDurationCompact(runtimeMs) ?? "n/a";
    const label = truncateLine(resolveSubagentLabel(entry), 48);
    const task = truncateLine(entry.task.trim(), params.taskMaxChars ?? 72);
    const taskName = entry.taskName?.trim();
    const taskNamePrefix = taskName ? `${taskName}: ` : "";
    const line = `${index}. ${taskNamePrefix}${label} (${resolveModelDisplay(sessionEntry, entry.model)}, ${runtime}${usageText ? `, ${usageText}` : ""}) ${status}${normalizeLowercaseStringOrEmpty(task) !== normalizeLowercaseStringOrEmpty(label) ? ` - ${task}` : ""}`;
    const view: SubagentListItem = {
      index,
      line,
      runId: entry.runId,
      sessionKey: entry.childSessionKey,
      ...(taskName ? { taskName } : {}),
      label,
      task,
      status,
      execution,
      ...(entry.delivery ? { deliveryStatus: entry.delivery.status } : {}),
      pendingDescendants,
      runtime,
      runtimeMs,
      ...(childSessions.length > 0 ? { childSessions } : {}),
      model: resolveModelRef(sessionEntry, entry.model),
      totalTokens,
      startedAt: getSubagentSessionStartedAt(entry),
      ...(entry.execution.endedAt ? { endedAt: entry.execution.endedAt } : {}),
    };
    index += 1;
    return view;
  };
  const active = runView.active.map((entry) =>
    buildListEntry(entry, getSubagentSessionRuntimeMs(entry, now) ?? 0),
  );
  const recent = runView.recent.map((entry) =>
    buildListEntry(entry, getSubagentSessionRuntimeMs(entry, entry.execution.endedAt ?? now) ?? 0),
  );
  return {
    total: runView.latest.length,
    active,
    recent,
    text: buildListText({ active, recent, recentMinutes: params.recentMinutes }),
  };
}
