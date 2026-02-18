/**
 * Shared helpers for compaction hook execution.
 *
 * Used by both `pi-embedded-runner/compact.ts` (manual/overflow compaction)
 * and `pi-embedded-subscribe.handlers.compaction.ts` (auto-compaction during
 * a live agent run) to avoid duplication.
 */

export const COMPACTION_HOOK_TIMEOUT_MS = 10_000;

export async function waitForHookWithTimeout(
  hookPromise: Promise<void>,
  opts: {
    timeoutMs?: number;
    onTimeout: (timeoutMs: number) => void;
  },
): Promise<void> {
  const timeoutMs = Math.max(0, opts.timeoutMs ?? COMPACTION_HOOK_TIMEOUT_MS);
  if (timeoutMs <= 0) {
    await hookPromise;
    return;
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      hookPromise,
      new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
        timeoutHandle.unref?.();
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
  if (timedOut) {
    opts.onTimeout(timeoutMs);
  }
}

export const cloneMessageForHook = (value: unknown): unknown => {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneMessageForHook(item));
  }
  if (value instanceof Date || value instanceof RegExp) {
    return structuredClone(value);
  }
  const source = value as Record<string, unknown>;
  const clone: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(source)) {
    clone[key] = cloneMessageForHook(nested);
  }
  return clone;
};

export const cloneMessagesForHook = (messages: readonly unknown[]): unknown[] => {
  try {
    return structuredClone(Array.from(messages));
  } catch {
    return messages.map((message) => cloneMessageForHook(message));
  }
};
