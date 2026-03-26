const pendingLinkOperations = new Map<string, Promise<unknown>>();

export function runCoalescedChatgptLinkOperation<TResult>(
  key: string,
  factory: () => Promise<TResult>,
): Promise<TResult> {
  const existing = pendingLinkOperations.get(key);
  if (existing) {
    return existing as Promise<TResult>;
  }

  const operation = factory();
  pendingLinkOperations.set(key, operation);

  operation.finally(() => {
    if (pendingLinkOperations.get(key) === operation) {
      pendingLinkOperations.delete(key);
    }
  });

  return operation;
}

export function resetChatgptAppsLinkState(): void {
  pendingLinkOperations.clear();
}
