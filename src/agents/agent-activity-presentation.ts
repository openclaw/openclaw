import { asOptionalObjectRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isAgentPlanProgressToolName } from "../session-cards/progress-card-input.js";

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
  const outcomes = { failed: 0, blocked: 0, unknown: 0 };
  let total = 0;
  for (const item of operations.values()) {
    if (item.hideFromChannelProgress || item.suppressChannelProgress) {
      continue;
    }
    // Prepared names describe operations, not successful effects or distinct
    // files. Free-form titles and metadata belong only in individual details.
    const name = normalizeLowercaseStringOrEmpty(item.name);
    const category = item.commandBearing ? "commands" : (ACTIVITY_CATEGORIES.get(name) ?? "other");
    counts[category] += 1;
    total += 1;
    if (item.status === "failed" || item.status === "blocked") {
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
