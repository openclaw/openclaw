type PendingRequest = {
  agentId: string;
  toolCallId: string;
  slug: string;
  reason: string;
};

export function takePendingAuthorization<T extends PendingRequest>(
  pending: Map<string, T>,
  exactKey: string,
  request: PendingRequest,
): T | undefined {
  const exact = pending.get(exactKey);
  if (exact) {
    pending.delete(exactKey);
    return exact;
  }

  let match: [string, T] | undefined;
  for (const entry of pending) {
    const candidate = entry[1];
    if (
      candidate.agentId !== request.agentId ||
      candidate.toolCallId !== request.toolCallId ||
      candidate.slug !== request.slug ||
      candidate.reason !== request.reason
    ) {
      continue;
    }
    if (match) {
      return undefined;
    }
    match = entry;
  }
  if (!match) {
    return undefined;
  }
  pending.delete(match[0]);
  return match[1];
}
