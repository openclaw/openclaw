/**
 * Active subagent prompt context builder.
 *
 * Renders sanitized runtime-owned subagent facts for the current-turn carrier.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolvePhysicalSessionStorePath } from "../../../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { sanitizeForPromptLiteral } from "../../sanitize-for-prompt.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../tools/sessions-helpers.js";
import { resolveSubagentCompletionResultText } from "../completion/subagent-completion-result.js";
import { isSubagentRunVisibleToSession } from "./subagent-control-scope.js";
import {
  buildSubagentList,
  captureSubagentListReadContext,
  readSubagentListSessionEntries,
} from "./subagent-list.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { buildSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import { withSubagentRunReadSnapshot } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// Prompt data is sanitized then JSON-quoted so active subagent state cannot add
// executable prompt instructions through labels or task text.
function quotePromptData(value: string): string {
  return JSON.stringify(sanitizeForPromptLiteral(value));
}

// Hard cap on completed children in the parent prompt. Bursty sequential
// spawn/finish cycles would otherwise grow every later parent turn unbounded.
const RECENT_PROMPT_MAX_ENTRIES = 8;
const PENDING_RESULT_MAX_ENTRIES = 8;
const PENDING_RESULT_MAX_CHARS = 2_000;

function hasOutstandingCompletion(entry: SubagentRunRecord): boolean {
  if (
    entry.execution.status !== "terminal" ||
    !Number.isFinite(entry.execution.endedAt) ||
    entry.suppressCompletionDelivery === true ||
    entry.killReconciliation?.suppressTaskDelivery === true ||
    entry.killIntent?.suppressTaskDelivery === true
  ) {
    return false;
  }
  if (entry.requesterSettleWake) {
    return true;
  }
  return (
    entry.completion?.required === true &&
    entry.delivery?.disposition !== "intentional_non_delivery" &&
    ["pending", "in_progress", "failed", "suspended"].includes(entry.delivery?.status ?? "pending")
  );
}

function formatPendingResult(entry: SubagentRunRecord): string {
  const result = resolveSubagentCompletionResultText(entry) ?? "";
  return [
    "-",
    `run_json=${quotePromptData(entry.runId)};`,
    `session_json=${quotePromptData(entry.childSessionKey)};`,
    `outcome=${entry.execution.outcome?.status ?? "unknown"};`,
    `delivery=${entry.delivery?.status ?? "pending"};`,
    `requester_continuation=${entry.requesterSettleWake?.status ?? "none"};`,
    `task_json=${quotePromptData(truncateUtf16Safe(entry.task, 96))};`,
    `result_json=${sanitizeForPromptLiteral(JSON.stringify(truncateUtf16Safe(result, PENDING_RESULT_MAX_CHARS)))};`,
    `result_truncated=${result.length > PENDING_RESULT_MAX_CHARS}`,
  ].join(" ");
}

/** Builds a bounded, deterministic snapshot without repeating system instructions. */
export async function buildActiveSubagentRuntimeContext(params: {
  cfg: OpenClawConfig;
  controllerSessionKey?: string;
  controllerAgentId?: string;
  recentMinutes?: number;
  includeSpawnContext?: boolean;
}): Promise<string | undefined> {
  const rawControllerSessionKey = params.controllerSessionKey?.trim();
  if (!rawControllerSessionKey) {
    return undefined;
  }
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const controllerSessionKey = resolveInternalSessionKey({
    key: rawControllerSessionKey,
    alias,
    mainKey,
  });
  const agentId = params.controllerAgentId ?? parseAgentSessionKey(controllerSessionKey)?.agentId;
  if (!agentId) {
    return undefined;
  }
  const storePath = resolvePhysicalSessionStorePath(
    { sessionKey: controllerSessionKey, agentId },
    params.cfg,
  );
  const isVisible = (entry: SubagentRunReadRecord) =>
    isSubagentRunVisibleToSession(entry, controllerSessionKey, agentId, params.cfg) &&
    ((entry.controllerSessionKey?.trim() === controllerSessionKey &&
      entry.controllerStorePath === storePath) ||
      (entry.requesterSessionKey.trim() === controllerSessionKey &&
        entry.requesterStorePath === storePath));
  return withSubagentRunReadSnapshot(
    subagentRuns,
    (snapshot) => {
      const index = buildSubagentRunReadIndexFromRuns({
        runs: snapshot,
        inMemoryRuns: subagentRuns.values(),
      });
      const yielded = [...index.latestRunsByChildSessionKey.values()].filter(
        (entry) => isVisible(entry) && entry.pauseReason === "sessions_yield",
      );
      return {
        index,
        runIds: [],
        sessionKeys: [controllerSessionKey, ...yielded.map((entry) => entry.childSessionKey)],
      };
    },
    ({ index }, snapshot) => {
      const latest = index.latestRunsByChildSessionKey;
      const visible = [...snapshot.values()].filter(isVisible);
      const runs = visible.filter(
        (entry) => latest.get(entry.childSessionKey.trim())?.runId === entry.runId,
      );
      // Read every retained generation through the same visibility policy. A newer
      // execution or a recent-history cutoff cannot acknowledge an older result.
      const pending = visible
        .filter(hasOutstandingCompletion)
        .toSorted(
          (left, right) =>
            (left.execution.endedAt ?? 0) - (right.execution.endedAt ?? 0) ||
            (left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0),
        );
      if (runs.length === 0 && pending.length === 0) {
        return undefined;
      }
      const recentMinutes = params.recentMinutes ?? 30;
      const context = captureSubagentListReadContext(runs, index, snapshot, recentMinutes);
      const list = buildSubagentList({
        context,
        sessionEntries: readSubagentListSessionEntries(params.cfg, context),
        taskMaxChars: 96,
      });
      // buildSubagentList returns recent runs in registry order, so sort before
      // capping to keep the prompt block deterministic across turns.
      const pendingIds = new Set(pending.map((entry) => entry.runId));
      const recentForPrompt = list.recent
        .filter((entry) => !pendingIds.has(entry.runId))
        .toSorted((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
        .slice(0, RECENT_PROMPT_MAX_ENTRIES);
      if (
        pending.length === 0 &&
        (params.includeSpawnContext === false ||
          (list.active.length === 0 && recentForPrompt.length === 0))
      ) {
        return undefined;
      }
      const formatEntry = (entry: (typeof list.active)[number]) =>
        [
          "-",
          entry.taskName
            ? `taskName_json=${quotePromptData(truncateUtf16Safe(entry.taskName, 64))};`
            : undefined,
          `session=${entry.sessionKey};`,
          `run=${entry.runId};`,
          `status=${entry.status};`,
          `execution=${entry.execution.state};`,
          entry.execution.wait ? `wait=${entry.execution.wait.kind};` : undefined,
          entry.execution.wait?.dependencies
            ? `wait_runs=${JSON.stringify(entry.execution.wait.dependencies.map((child) => child.runId))};`
            : undefined,
          entry.deliveryStatus ? `delivery=${entry.deliveryStatus};` : undefined,
          `label_json=${quotePromptData(entry.label)};`,
          `task_json=${quotePromptData(entry.task)}`,
        ]
          .filter(Boolean)
          .join(" ");
      const lines: string[] = [];
      if (params.includeSpawnContext !== false && list.active.length > 0) {
        lines.push(
          "## Active Subagents",
          ...list.active
            .toSorted((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
            .slice(0, 16)
            .map(formatEntry),
          ...(list.active.length > 16 ? [`- additional_runs=${list.active.length - 16}`] : []),
        );
      }
      if (params.includeSpawnContext !== false && recentForPrompt.length > 0) {
        if (lines.length > 0) {
          lines.push("");
        }
        lines.push(
          "## Recently Completed Subagents",
          `Children that ended in the last ${recentMinutes}m, newest first:`,
          ...recentForPrompt.map(formatEntry),
        );
      }
      if (pending.length > 0) {
        if (lines.length > 0) {
          lines.push("");
        }
        lines.push(
          "## Child results awaiting delivery",
          ...pending.slice(0, PENDING_RESULT_MAX_ENTRIES).map(formatPendingResult),
          ...(pending.length > PENDING_RESULT_MAX_ENTRIES
            ? [`- additional_results=${pending.length - PENDING_RESULT_MAX_ENTRIES}`]
            : []),
        );
      }
      return lines.join("\n");
    },
  );
}
