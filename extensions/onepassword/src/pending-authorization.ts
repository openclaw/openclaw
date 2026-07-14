type PendingRequest = {
  agentId: string;
  toolCallId: string;
  slug: string;
  reason: string;
};

export function findPendingAuthorization<T extends PendingRequest>(
  pending: ReadonlyMap<string, T>,
  exactKey: string,
  request: PendingRequest,
): [key: string, authorization: T | undefined] {
  const exact = pending.get(exactKey);
  if (exact) {
    return [exactKey, exact];
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
      return [exactKey, undefined];
    }
    match = entry;
  }
  return match ?? [exactKey, undefined];
}
