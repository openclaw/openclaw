const emittedRegistrationLogs = new Set<string>();

export function logFeishuRegistrationOnce(
  logger: { info?: (message: string) => void },
  key: string,
  message: string,
) {
  if (emittedRegistrationLogs.has(key)) {
    return;
  }
  emittedRegistrationLogs.add(key);
  logger.info?.(message);
}

export function resetFeishuRegistrationLogOnceForTests() {
  emittedRegistrationLogs.clear();
}
