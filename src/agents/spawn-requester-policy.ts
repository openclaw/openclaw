/** Sender policy provenance is host-owned and survives delegated turns. */
export function resolveSenderRestrictedSpawnError(params: {
  inheritedToolPolicySource?: "sender";
  requesterAgentId?: string;
  targetAgentId?: string;
  visible?: boolean;
}): string | undefined {
  if (
    params.inheritedToolPolicySource === "sender" &&
    (params.visible || (params.targetAgentId && params.targetAgentId !== params.requesterAgentId))
  ) {
    return "This sender may only start hidden helpers of the same agent.";
  }
  return undefined;
}
