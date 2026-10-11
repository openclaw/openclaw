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
    (name === "process" && asRecord(facts.args)?.action === "poll") ||
    (name === "message" && asRecord(facts.args)?.action === "react");
  return routine && (item.status === "running" || item.status === "completed")
    ? { ...item, hideFromChannelProgress: true }
    : item;
}

export function isCompleteAgentPreamble(item: { phase?: string; progressText?: string }): boolean {
  return !item.progressText?.trim() || (item.phase !== "start" && item.phase !== "update");
}

/**
 * A `sessions_spawn` operation counts as a subagent only when it started one:
 * a launch that failed, was blocked or was skipped is one more operation.
 * `ownSessionLaunches` names the launches that opened a session in its own
 * right. Prepared items do not carry the arguments that say so; a caller that
 * has them keeps those launches out of the subagents.
 */
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
  opts: { ownSessionLaunches?: ReadonlySet<string> } = {},
) {
  const operations = new Map(
    items
      .filter((item) => !item.suppressChannelProgress)
      .map((item) => [item.toolCallId ?? item.itemId, item]),
  );
  // Key order is the order a summary lists them; subagents close it.
  const counts = {
    commands: 0,
    reads: 0,
    edits: 0,
    writes: 0,
    searches: 0,
    fetches: 0,
    other: 0,
    subagents: 0,
  };
  const outcomes = { failed: 0, blocked: 0, skipped: 0, unknown: 0 };
  let total = 0;
  for (const [operation, item] of operations) {
    if (item.hideFromChannelProgress) {
      continue;
    }
    // Prepared names describe operations, not successful effects or distinct
    // files. Free-form titles and metadata belong only in individual details.
    const name = normalizeLowercaseStringOrEmpty(item.name);
    const named = ACTIVITY_CATEGORIES.get(name) ?? "other";
    // An operation that ended one of these ways; a launch that did started nothing.
    const outcome =
      item.status === "failed" || item.status === "blocked" || item.status === "skipped"
        ? item.status
        : undefined;
    const category = item.commandBearing
      ? "commands"
      : named === "subagents" && (outcome || opts.ownSessionLaunches?.has(operation))
        ? "other"
        : named;
    counts[category] += 1;
    total += 1;
    if (outcome) {
      outcomes[outcome] += 1;
    } else if (!item.status) {
      outcomes.unknown += 1;
    }
  }
  return { total, counts, outcomes };
}

function categoryTools<Category extends string>(category: Category, names: string[]) {
  return names.map((name) => [name, category] as const);
}

const ACTIVITY_CATEGORIES = new Map([
  // A launched subagent is a worker, not one more operation of the launcher.
  ...categoryTools("subagents", ["sessions_spawn"]),
  ...categoryTools("commands", ["exec", "bash", "shell", "run_command", "run_terminal_cmd"]),
  ...categoryTools("reads", ["read", "read_file", "readfile", "notebookread", "notebook_read"]),
  ...categoryTools("edits", [
    "edit",
    "apply_patch",
    "applypatch",
    "patch",
    "edit_file",
    "multiedit",
    "multi_edit",
    "notebookedit",
    "notebook_edit",
  ]),
  ...categoryTools("writes", ["write", "write_file", "create_file"]),
  ...categoryTools("searches", [
    "grep",
    "glob",
    "find",
    "ls",
    "list",
    "codebase_search",
    "web_search",
  ]),
  ...categoryTools("fetches", ["web_fetch", "webfetch", "fetch"]),
]);
