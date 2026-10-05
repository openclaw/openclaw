import { asOptionalObjectRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  groupToolCalls,
  type ToolCallGroup,
  type ToolCallIdentity,
} from "../chat/tool-call-grouping.js";
import { isAgentPlanProgressToolName } from "../session-cards/progress-card-input.js";

/**
 * A successfully completed wrapper is replaced only by a recorded call beneath it
 * that stays visible in progress. A wrapper whose recorded calls are all routine
 * stays the operation instead of leaving none.
 */
export function resolveCompletedActivityWrappers<
  Call extends ToolCallIdentity & {
    activity?: {
      status?: string;
      hideFromChannelProgress?: boolean;
      suppressChannelProgress?: boolean;
    };
  },
>(calls: readonly Call[]): Set<Call> {
  const wrappers = new Set<Call>();
  const parentsFirst: ToolCallGroup<Call>[] = [];
  const pending = groupToolCalls(calls);
  while (pending.length > 0) {
    const group = pending.pop()!;
    parentsFirst.push(group);
    for (const child of group.children) {
      pending.push(child);
    }
  }
  // Children settle before their parent: a nested wrapper kept for its own routine
  // calls stands for the wrapper above it, and so does a visible call under a hidden one.
  const shown = new Set<ToolCallGroup<Call>>();
  for (const group of parentsFirst.toReversed()) {
    const { activity } = group.card;
    const childShown = group.children.some((child) => shown.has(child));
    if (childShown && activity?.status === "completed") {
      wrappers.add(group.card);
    }
    // A call still active at settlement has no recorded outcome, so on its own it does
    // not stand for its wrapper; a visible call beneath it still does.
    if (
      childShown ||
      (activity && !activity.hideFromChannelProgress && !activity.suppressChannelProgress)
    ) {
      shown.add(group);
    }
  }
  return wrappers;
}

export function projectAgentActivityItem<
  Item extends {
    kind?: string;
    name?: string;
    status?: string;
    phase?: string;
    hideFromChannelProgress?: boolean;
  },
>(
  item: Item,
  facts: { args?: unknown; result?: unknown; nativeOperation?: "wait" | "process.poll" } = {},
): Item & { hideFromChannelProgress?: boolean } {
  if (item.kind === "analysis") {
    return { ...item, hideFromChannelProgress: true };
  }
  const name = normalizeLowercaseStringOrEmpty(item.name);
  const details = asRecord(asRecord(facts.result)?.details);
  // Tool completion is not command success. Preserve the execution contract and
  // expose a normal nonzero exit only in the prepared activity outcome.
  if (
    item.phase === "end" &&
    item.status === "completed" &&
    (name === "exec" || name === "bash" || name === "process") &&
    details?.status === "completed" &&
    details.exitReason !== "manual-cancel" &&
    typeof details.exitCode === "number" &&
    Number.isFinite(details.exitCode) &&
    details.exitCode !== 0
  ) {
    return { ...item, status: "failed" };
  }
  const routine =
    facts.nativeOperation === "wait" ||
    facts.nativeOperation === "process.poll" ||
    isAgentPlanProgressToolName(name) ||
    name === "sessions_yield" ||
    (name === "process" && asRecord(facts.args)?.action === "poll");
  return routine && (item.status === "running" || item.status === "completed")
    ? { ...item, hideFromChannelProgress: true }
    : item;
}

export function isCompleteAgentPreamble(item: { phase?: string; progressText?: string }): boolean {
  return !item.progressText?.trim() || (item.phase !== "start" && item.phase !== "update");
}

export function summarizeAgentActivity(
  items: readonly {
    itemId: string;
    toolCallId?: string;
    title: string;
    name?: string;
    commandBearing?: boolean;
    status?: string;
    hideFromChannelProgress?: boolean;
    suppressChannelProgress?: boolean;
  }[],
) {
  const operations = new Map(
    items
      .filter((item) => !item.suppressChannelProgress)
      .map((item) => [item.toolCallId ?? item.itemId, item]),
  );
  const counts = { commands: 0, reads: 0, edits: 0, writes: 0, searches: 0, fetches: 0, other: 0 };
  const outcomes = { failed: 0, blocked: 0, skipped: 0, unknown: 0 };
  let total = 0;
  for (const item of operations.values()) {
    if (item.hideFromChannelProgress) {
      continue;
    }
    // Prepared names describe operations, not successful effects or distinct
    // files. Free-form titles and metadata belong only in individual details.
    const name = normalizeLowercaseStringOrEmpty(item.name);
    const category = item.commandBearing ? "commands" : (ACTIVITY_CATEGORIES.get(name) ?? "other");
    counts[category] += 1;
    total += 1;
    if (item.status === "failed" || item.status === "blocked" || item.status === "skipped") {
      outcomes[item.status] += 1;
    } else if (!item.status) {
      outcomes.unknown += 1;
    }
  }
  return { total, counts, outcomes };
}

const ACTIVITY_CATEGORIES = new Map<
  string,
  "commands" | "reads" | "edits" | "writes" | "searches" | "fetches"
>([
  ["exec", "commands"],
  ["bash", "commands"],
  ["shell", "commands"],
  ["run_command", "commands"],
  ["run_terminal_cmd", "commands"],
  ["read", "reads"],
  ["read_file", "reads"],
  ["readfile", "reads"],
  ["notebookread", "reads"],
  ["notebook_read", "reads"],
  ["edit", "edits"],
  ["apply_patch", "edits"],
  ["applypatch", "edits"],
  ["patch", "edits"],
  ["edit_file", "edits"],
  ["multiedit", "edits"],
  ["multi_edit", "edits"],
  ["notebookedit", "edits"],
  ["notebook_edit", "edits"],
  ["write", "writes"],
  ["write_file", "writes"],
  ["create_file", "writes"],
  ["grep", "searches"],
  ["glob", "searches"],
  ["find", "searches"],
  ["ls", "searches"],
  ["list", "searches"],
  ["codebase_search", "searches"],
  ["web_search", "searches"],
  ["web_fetch", "fetches"],
  ["webfetch", "fetches"],
  ["fetch", "fetches"],
]);
