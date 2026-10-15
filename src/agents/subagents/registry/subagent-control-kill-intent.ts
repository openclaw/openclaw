import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function matchesSubagentKillIntent(
  intent: SubagentRunRecord["killIntent"],
  claim: NonNullable<SubagentRunRecord["killIntent"]>,
): boolean {
  return (
    intent !== undefined &&
    intent.requestedAt === claim.requestedAt &&
    intent.reason === claim.reason &&
    intent.lifecycleGeneration === claim.lifecycleGeneration &&
    intent.sessionId === claim.sessionId &&
    intent.sessionLifecycleRevision === claim.sessionLifecycleRevision &&
    intent.suppressTaskDelivery === claim.suppressTaskDelivery
  );
}
