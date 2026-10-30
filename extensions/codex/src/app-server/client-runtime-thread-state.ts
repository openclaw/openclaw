import { readCodexAppServerThreadOwnershipState } from "./client-runtime.js";
import { isThreadBackgroundOnly, waitForThreadBackgroundCleanup } from "./client-thread-owner.js";
import type { CodexAppServerClient } from "./client.js";

/** Completed foreground work may leave cleanup custody with native background work. */
export function isCodexAppServerLiveThreadBackgroundOnly(
  client: CodexAppServerClient,
  threadId: string,
  configFingerprint?: string,
): boolean {
  return isThreadBackgroundOnly(
    readCodexAppServerThreadOwnershipState(client),
    threadId,
    configFingerprint,
  );
}

export function waitForCodexAppServerThreadBackgroundCleanup(
  client: CodexAppServerClient,
  threadId: string,
  signal: AbortSignal,
): Promise<void> {
  return waitForThreadBackgroundCleanup(
    readCodexAppServerThreadOwnershipState(client),
    threadId,
    signal,
  );
}
