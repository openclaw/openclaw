export const SUBAGENT_COMPLETION_OWNERS = [
  "requester-session-final",
  "work-thread-final",
  "origin-bridge-final",
  "none",
] as const;

export type SubagentCompletionOwner = (typeof SUBAGENT_COMPLETION_OWNERS)[number];

const SUBAGENT_COMPLETION_OWNER_SET = new Set<string>(SUBAGENT_COMPLETION_OWNERS);

export function normalizeSubagentCompletionOwner(
  value: unknown,
): SubagentCompletionOwner | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return SUBAGENT_COMPLETION_OWNER_SET.has(normalized)
    ? (normalized as SubagentCompletionOwner)
    : undefined;
}

export function completionOwnerNeedsRequesterFinal(owner: SubagentCompletionOwner): boolean {
  return owner === "requester-session-final" || owner === "origin-bridge-final";
}

export function resolveSubagentCompletionOwner(params: {
  requestedOwner?: unknown;
  expectsCompletionMessage: boolean;
  threadBoundDirectDelivery: boolean;
}): SubagentCompletionOwner {
  const requested = normalizeSubagentCompletionOwner(params.requestedOwner);
  if (requested) {
    return requested;
  }
  if (params.threadBoundDirectDelivery) {
    return "work-thread-final";
  }
  if (params.expectsCompletionMessage) {
    return "requester-session-final";
  }
  return "none";
}
