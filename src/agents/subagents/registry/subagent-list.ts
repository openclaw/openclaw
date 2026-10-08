import { realpathSync } from "node:fs";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveSubagentLabel } from "../../../auto-reply/reply/subagents-utils.js";
import { readSessionEntriesFromStoreInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatDurationCompact } from "../../../infra/format-time/format-duration.js";
import { resolveUserPath } from "../../../infra/home-dir.js";
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
import {
  isRetainedUnendedSubagentRun,
  shouldKeepSubagentRunChildLink,
} from "./subagent-run-liveness.js";
import { buildSubagentRunView } from "./subagent-run-view.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  resolveSubagentDisplayStatus,
} from "./subagent-session-metrics.js";

/**
 * Model-visible bounds for the shared-cwd advisory.
 *
 * `subagents list` emits one structured row per live run *and* the rendered text
 * view, so whatever the advisory attaches to a row reaches the model roughly
 * twice per run. Naming every peer therefore made the advisory quadratic: at the
 * schema maximum of 20 children for one agent session
 * (`maxChildrenPerAgent`, `.max(20)` in `zod-schema.agent-defaults.ts`) a single
 * ordinary `list` call emitted 380 run ids and 40 copies of the directory —
 * measured at ~30 KB / ~7.5K tokens, and ~134 KB / ~33K tokens for a 50-child
 * swarm group. AGENTS.md's model-context budget makes an unbounded model-visible
 * item a release blocker, so each shared directory is emitted once in a bounded
 * top-level summary. Rows carry only its small numeric group id.
 */
const SHARED_CWD_GROUP_MAX = 8;
const SHARED_CWD_RUN_SAMPLE_MAX = 3;
const SHARED_CWD_PATH_MAX_CHARS = 72;

/**
 * Advisory marker for live sibling runs spawned into one working directory.
 * Present only when the spawner passed an explicit `cwd`; inherited workspaces
 * are shared by design and are never reported.
 */
type SubagentSharedCwdGroup = {
  /** Stable within one list response; rows refer to this id. */
  id: number;
  /**
   * The shared directory, capped at `SHARED_CWD_PATH_MAX_CHARS` for display. The
   * untruncated path stays internal to grouping and is never emitted per row.
   */
  path: string;
  /** Exact live-run count for the group. */
  runCount: number;
  /**
   * At most `SHARED_CWD_RUN_SAMPLE_MAX` run ids, ordered by run id. A sample,
   * not an inventory — read `runCount` for the real total.
   */
  runIds: string[];
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

/**
 * Canonical on-disk identity for one explicit working directory.
 *
 * Two explicit paths can name a single directory through a symlink, or through
 * a case alias on a case-insensitive volume, so lexical equality under-reports
 * real collisions. `realpathSync.native` collapses both classes: it follows
 * links and returns the directory's true on-disk casing. The memo keeps this to
 * one syscall per distinct explicit cwd among live runs — this list is built on
 * an operator or agent `list` call, not on a message hot path.
 *
 * A path that cannot be resolved (already deleted, or unreadable) keeps its
 * lexical form. That can only split a group, never merge unrelated ones, so a
 * failed probe under-reports rather than fabricating a collision.
 */
function canonicalCwdIdentity(resolved: string, memo: Map<string, string>) {
  const cached = memo.get(resolved);
  if (cached !== undefined) {
    return cached;
  }
  let identity = resolved;
  try {
    identity = realpathSync.native(resolved);
  } catch {
    // Keep the lexical path; see the fail-open note above.
  }
  memo.set(resolved, identity);
  return identity;
}

/** Case-fold the grouping key only where the platform filesystem is case-insensitive. */
function sharedCwdGroupKey(identity: string) {
  return process.platform === "win32" ? identity.toLowerCase() : identity;
}

/** Locale-independent code-unit ordering; `localeCompare` would vary by host ICU data. */
function compareCodeUnits(a: string, b: string) {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Cap a shared directory for display, keeping the tail.
 *
 * Sibling checkouts share long leading prefixes, so the house head-preserving
 * `truncateLine` would render every distinct group as the same unusable prefix.
 * The leaf directories are what tell two groups apart, so the ellipsis goes in
 * front. `sliceUtf16Safe` takes the negative offset and keeps the cut off a
 * surrogate pair.
 */
function capSharedCwdPath(value: string) {
  if (value.length <= SHARED_CWD_PATH_MAX_CHARS) {
    return value;
  }
  const marker = "...";
  return `${marker}${sliceUtf16Safe(value, -(SHARED_CWD_PATH_MAX_CHARS - marker.length))}`;
}

/**
 * Index live runs by the explicit working directory they were spawned into.
 *
 * Reads `spawnedCwd` off `sessionEntries`, the selection the caller already
 * loaded via `readSubagentListSessionEntries` for the visible children, so
 * grouping performs no session I/O of its own. That reuse is sound rather than
 * best-effort: every run this function considers passes
 * `isRetainedUnendedSubagentRun` at the same `now`, and `buildSubagentRunView`
 * puts exactly those runs in `active` — so their child session keys are always
 * part of the selection `readSubagentListSessionEntries` requested. A second
 * whole-store read would materialize a summary object per unrelated session on
 * every `list` call and on active-child context construction;
 * `readSubagentListSessionEntries` passes `sessionKeys`, so nothing outside the
 * visible children is ever materialized.
 *
 * The only filesystem work is one canonicalization per distinct explicit
 * directory (see `canonicalCwdIdentity`). Runs without an explicit `spawnedCwd`
 * inherited the parent workspace — the default for `collect` swarms — and are
 * skipped so the advisory stays silent on normal usage.
 */
function buildSharedCwdIndex(params: {
  runs: SubagentRunRecord[];
  sessionEntries: ReadonlyMap<string, SessionEntry>;
  now: number;
}) {
  const groups = new Map<string, { path: string; displayPath: string; runIds: string[] }>();
  const identityMemo = new Map<string, string>();
  for (const run of params.runs) {
    if (!isRetainedUnendedSubagentRun(run, params.now)) {
      continue;
    }
    const spawnedCwd = params.sessionEntries.get(run.childSessionKey)?.spawnedCwd?.trim();
    if (!spawnedCwd) {
      continue;
    }
    const resolved = resolveUserPath(spawnedCwd);
    if (!resolved) {
      continue;
    }
    const identity = canonicalCwdIdentity(resolved, identityMemo);
    const groupKey = sharedCwdGroupKey(identity);
    const existing = groups.get(groupKey);
    if (existing) {
      existing.runIds.push(run.runId);
      continue;
    }
    // Report the canonical directory rather than whichever alias was named
    // first, so the operator sees the checkout the runs actually share. The cap
    // is applied once per group, not once per emitted row.
    groups.set(groupKey, {
      path: identity,
      displayPath: capSharedCwdPath(identity),
      runIds: [run.runId],
    });
  }
  // Order the report by keys that depend only on live state, before the caps
  // narrow it.
  //
  // `groups` iterates in insertion order and `runIds` accumulate in encounter
  // order, both inherited from `sortSubagentRuns`, which compares start
  // timestamps only. Runs that started in the same millisecond therefore keep
  // whatever order the caller's array happened to have — and that permutation
  // would otherwise decide the group ids, which runs each group samples, and
  // (past `SHARED_CWD_GROUP_MAX`) which directories are reported at all, for
  // identical live state.
  //
  // Groups sort by descending live-run count so the cap keeps the most
  // contended directories, with the canonical grouping key as the tiebreak;
  // samples sort by run id. Both tiebreaks are unique — one group per key, one
  // record per run id — so each comparator is a total order and the reported
  // shape is a function of the live runs alone.
  const orderedGroups = [...groups]
    .filter(([, group]) => group.runIds.length >= 2)
    .map(([key, group]) => ({
      key,
      displayPath: group.displayPath,
      runIds: group.runIds.toSorted(compareCodeUnits),
    }))
    .toSorted((a, b) => b.runIds.length - a.runIds.length || compareCodeUnits(a.key, b.key));
  const sharedCwdGroups: SubagentSharedCwdGroup[] = [];
  const groupIdByRunId = new Map<string, number>();
  const sharedCwdGroupTotal = orderedGroups.length;
  for (const group of orderedGroups) {
    if (sharedCwdGroups.length >= SHARED_CWD_GROUP_MAX) {
      break;
    }
    const id = sharedCwdGroups.length + 1;
    const sampledRunIds = group.runIds.slice(0, SHARED_CWD_RUN_SAMPLE_MAX);
    sharedCwdGroups.push({
      id,
      path: group.displayPath,
      runCount: group.runIds.length,
      runIds: sampledRunIds,
    });
    // Keep the advisory constant-cost even when one configured swarm has
    // thousands of members. The exact total lives on the group summary; row
    // references are only navigation aids for its bounded sample.
    for (const runId of sampledRunIds) {
      groupIdByRunId.set(runId, id);
    }
  }
  return {
    resolveGroupId: (runId: string) => groupIdByRunId.get(runId),
    sharedCwdGroupTotal,
    sharedCwdGroups,
  };
}

function buildListText(params: {
  active: Array<{ line: string }>;
  recent: Array<{ line: string }>;
  recentMinutes: number;
  sharedCwdGroupTotal: number;
  sharedCwdGroups: SubagentSharedCwdGroup[];
}) {
  const lines = [
    "active subagents:",
    ...(params.active.length ? params.active.map((entry) => entry.line) : ["(none)"]),
    "",
    `recent (last ${params.recentMinutes}m):`,
    ...(params.recent.length ? params.recent.map((entry) => entry.line) : ["(none)"]),
  ];
  if (params.sharedCwdGroupTotal > 0) {
    lines.push(
      "",
      `shared working directories (${params.sharedCwdGroups.length}/${params.sharedCwdGroupTotal} shown):`,
      ...params.sharedCwdGroups.map(
        (group) =>
          `[cwd ${group.id}] ${group.runCount} live runs: ${group.path} (sample: ${group.runIds.join(", ")})`,
      ),
    );
  }
  return lines.join("\n");
}

export function buildSubagentList(params: {
  context: SubagentListReadContext;
  sessionEntries: ReadonlyMap<string, SessionEntry>;
  taskMaxChars?: number;
}) {
  const { now, view: runView, childSessionsByController } = params.context;
  // `runView.latest` is this function's former `dedupedRuns`: same sort, same
  // dedup by childSessionKey, same authority.
  const sharedCwdIndex = buildSharedCwdIndex({
    runs: runView.latest,
    sessionEntries: params.sessionEntries,
    now,
  });
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
    const sharedCwdGroupId = sharedCwdIndex.resolveGroupId(entry.runId);
    const sharedCwdSuffix = sharedCwdGroupId ? ` [shared cwd group ${sharedCwdGroupId}]` : "";
    const line = `${index}. ${taskNamePrefix}${label} (${resolveModelDisplayName(modelSelection)}, ${runtime}${usageText ? `, ${usageText}` : ""}) ${status}${normalizeLowercaseStringOrEmpty(task) !== normalizeLowercaseStringOrEmpty(label) ? ` - ${task}` : ""}${sharedCwdSuffix}`;
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
      ...(sharedCwdGroupId ? { sharedCwdGroupId } : {}),
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
    sharedCwdGroupTotal: sharedCwdIndex.sharedCwdGroupTotal,
    sharedCwdGroups: sharedCwdIndex.sharedCwdGroups,
    text: buildListText({
      active,
      recent,
      recentMinutes: params.context.recentMinutes,
      sharedCwdGroupTotal: sharedCwdIndex.sharedCwdGroupTotal,
      sharedCwdGroups: sharedCwdIndex.sharedCwdGroups,
    }),
  };
}
