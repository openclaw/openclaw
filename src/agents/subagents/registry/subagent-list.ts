import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveSubagentLabel } from "../../../auto-reply/reply/subagents-utils.js";
import { readSessionEntriesFromStoreInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatDurationCompact } from "../../../infra/format-time/format-duration.js";
import {
  formatTokenUsageDisplay,
  resolveTotalTokens,
  truncateLine,
} from "../../../shared/subagents-format.js";
import { resolveModelDisplayName, resolveModelDisplayRef } from "../../model-selection-display.js";
import { resolveSubagentChildSessionOwner } from "./subagent-child-session-owner.js";
import {
  observeSubagentExecution,
  type SubagentExecutionObservation,
} from "./subagent-execution-observation.js";
import type { SubagentRunReadIndex } from "./subagent-registry-queries.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { shouldKeepSubagentRunChildLink } from "./subagent-run-liveness.js";
import { buildSubagentRunView } from "./subagent-run-view.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  resolveSubagentDisplayStatus,
} from "./subagent-session-metrics.js";

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
      readIndex.countPendingDescendantRuns(entry.childSessionKey, {
        excludeSuspendedDelivery: true,
      }),
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
  const batches = new Map<
    string,
    { agentId: string; storePath: string; runs: SubagentRunRecord[] }
  >();
  for (const run of runs) {
    const owner = resolveSubagentChildSessionOwner(run, cfg);
    const batch = batches.get(owner.agentId);
    if (batch) {
      batch.runs.push(run);
    } else {
      batches.set(owner.agentId, { ...owner, runs: [run] });
    }
  }
  // Raw session keys can repeat across agents; keep each run's metadata separate.
  const entries = new Map<string, SessionEntry>();
  for (const { agentId, storePath, runs: batchRuns } of batches.values()) {
    const selected = await readSessionEntriesFromStoreInWorker({
      agentId,
      storePath,
      sessionKeys: batchRuns.map((run) => run.childSessionKey),
      projection: "list",
    });
    const bySessionKey = new Map(
      selected.entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
    );
    for (const run of batchRuns) {
      const entry = bySessionKey.get(run.childSessionKey);
      if (entry) {
        entries.set(run.runId, entry);
      }
    }
  }
  return entries;
}

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
    const children = childSessionsByController.get(controllerSessionKey) ?? [];
    children.push(childSessionKey);
    childSessionsByController.set(controllerSessionKey, children);
  }
  for (const [controllerSessionKey, childSessions] of childSessionsByController) {
    childSessionsByController.set(controllerSessionKey, childSessions.toSorted());
  }

  return childSessionsByController;
}

export function buildSubagentList(params: {
  context: SubagentListReadContext;
  sessionEntries: ReadonlyMap<string, SessionEntry>;
  taskMaxChars?: number;
}) {
  const { now, view: runView, childSessionsByController } = params.context;
  let index = 1;
  const buildListEntry = (entry: SubagentRunRecord, runtimeMs: number) => {
    const sessionEntry = params.sessionEntries.get(entry.runId);
    const modelSelection = {
      runtimeProvider: sessionEntry?.modelProvider,
      runtimeModel: sessionEntry?.model,
      overrideProvider: sessionEntry?.providerOverride,
      overrideModel: sessionEntry?.modelOverride,
      fallbackModel: entry.model,
    };
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
    const line = `${index}. ${taskNamePrefix}${label} (${resolveModelDisplayName(modelSelection)}, ${runtime}${usageText ? `, ${usageText}` : ""}) ${status}${normalizeLowercaseStringOrEmpty(task) !== normalizeLowercaseStringOrEmpty(label) ? ` - ${task}` : ""}`;
    const view = {
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
      model: resolveModelDisplayRef(modelSelection),
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
    text: [
      "active subagents:",
      ...(active.length ? active.map((entry) => entry.line) : ["(none)"]),
      "",
      `recent (last ${params.context.recentMinutes}m):`,
      ...(recent.length ? recent.map((entry) => entry.line) : ["(none)"]),
    ].join("\n"),
  };
}
