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
    status?: string;
    hideFromChannelProgress?: boolean;
    suppressChannelProgress?: boolean;
  }[],
): string {
  const operations = new Map(
    items
      .filter((item) => !item.suppressChannelProgress)
      .map((item) => [item.toolCallId ?? item.itemId, item]),
  );
  const titles = new Map<string, number>();
  for (const item of operations.values()) {
    if (item.hideFromChannelProgress || item.suppressChannelProgress) {
      continue;
    }
    const title =
      item.status === "failed" || item.status === "blocked"
        ? `${item.title} (${item.status})`
        : item.title;
    titles.set(title, (titles.get(title) ?? 0) + 1);
  }
  return [...titles]
    .map(([title, count]) => (count === 1 ? title : `${title} ×${count}`))
    .join(", ");
}
