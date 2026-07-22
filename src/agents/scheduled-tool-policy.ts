/**
 * Trusted runtime context for a scheduled run with a server-stamped tool cap.
 * The owner session selects group policy; sender-specific policy was already
 * projected into the immutable cap when the job was created.
 */
export type ScheduledToolPolicyContext = {
  ownerSessionKey: string;
};

/** Builds scheduled policy context only when both the cap and trusted owner exist. */
export function resolveScheduledToolPolicyContext(params: {
  toolsAllow?: readonly string[];
  ownerSessionKey?: string | null;
}): ScheduledToolPolicyContext | undefined {
  if (params.toolsAllow === undefined) {
    return undefined;
  }
  const ownerSessionKey = params.ownerSessionKey?.trim();
  return ownerSessionKey ? { ownerSessionKey } : undefined;
}
