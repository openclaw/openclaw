/**
 * Subagent list builder.
 *
 * Combines live registry runs and persisted session metadata for sessions_list/subagents views.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveSubagentLabel } from "../../../auto-reply/reply/subagents-utils.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { readSessionEntriesFromStoreInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target-paths.js";
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
import type { SubagentRunReadIndex } from "./subagent-registry-queries.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
} from "./subagent-registry-read.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
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

export type SubagentListReadContext = {
  now: number;
  recentMinutes: number;
  view: ReturnType<typeof buildSubagentRunView>;
  childSessionsByController: ReadonlyMap<string, string[]>;
  pendingDescendants: ReadonlyMap<string, number>;
  execution: ReadonlyMap<string, SubagentExecutionObservation>;
};

/** Capture live classification before the prepared registry view crosses a Promise boundary. */
export function captureSubagentListReadContext(
  runs: SubagentRunRecord[],
  readIndex: SubagentRunReadIndex<SubagentRunReadRecord>,
  fullRuns: ReadonlyMap<string, SubagentRunRecord>,
  recentMinutes: number,
): SubagentListReadContext {
  const now = Date.now();
  const childSessionsByController = buildChildSessionIndex(readIndex, now);
  const pendingDescendants = new Map(
    runs.map((entry) => [
      entry.childSessionKey,
      readIndex.countPendingDescendantRuns(entry.childSessionKey),
    ]),
  );
  const view = buildSubagentRunView({
    runs,
    recentMinutes,
    countPendingDescendantRuns: (key) => pendingDescendants.get(key) ?? 0,
    now,
  });
  const execution = new Map(
    [...view.active, ...view.recent].map((entry) => [
      entry.runId,
      observeSubagentExecution(
        entry,
        entry.pauseReason === "sessions_yield" ? fullRuns.values() : [],
      ),
    ]),
  );
  return {
    now,
    recentMinutes,
    view: structuredClone(view),
    childSessionsByController,
    pendingDescendants,
    execution,
  };
}

export async function readSubagentListSessionEntries(
  cfg: OpenClawConfig,
  context: SubagentListReadContext,
): Promise<Map<string, SessionEntry>> {
  const runs = [...context.view.active, ...context.view.recent];
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
    const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
    const agentId = target.agentId ?? parseAgentSessionKey(sessionKeys[0]!)?.agentId;
    if (!agentId) {
      throw new Error("Cannot resolve subagent session metadata without an agent id");
    }
    const selected = await readSessionEntriesFromStoreInWorker({
      agentId,
      storePath,
      sessionKeys,
      projection: "list",
    });
    for (const { sessionKey, entry } of selected.entries) {
      entries.set(sessionKey, entry);
    }
  }
  return entries;
}

/** Build child-session indexes from the latest run associated with each child key. */
function buildChildSessionIndex(
  readIndex: SubagentRunReadIndex<SubagentRunReadRecord>,
  now: number,
) {
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

  return childSessionsByController;
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
  context: SubagentListReadContext;
  sessionEntries: ReadonlyMap<string, SessionEntry>;
  taskMaxChars?: number;
}): BuiltSubagentList {
  const { now, view: runView, childSessionsByController } = params.context;
  let index = 1;
  const buildListEntry = (entry: SubagentRunRecord, runtimeMs: number) => {
    const sessionEntry = params.sessionEntries.get(entry.childSessionKey);
    const totalTokens = resolveTotalTokens(sessionEntry);
    const usageText = formatTokenUsageDisplay(sessionEntry);
    const pendingDescendants = params.context.pendingDescendants.get(entry.childSessionKey) ?? 0;
    const execution = params.context.execution.get(entry.runId)!;
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
    text: buildListText({ active, recent, recentMinutes: params.context.recentMinutes }),
  };
}
