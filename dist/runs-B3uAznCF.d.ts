//#region src/agents/pi-embedded-runner/run-state.d.ts
type EmbeddedPiQueueHandle = {
  kind?: "embedded";
  queueMessage: (text: string, options?: EmbeddedPiQueueMessageOptions) => Promise<void>;
  isStreaming: () => boolean;
  isCompacting: () => boolean;
  cancel?: (reason?: "user_abort" | "restart" | "superseded") => void;
  abort: () => void;
};
type EmbeddedPiQueueMessageOptions = {
  steeringMode?: "all" | "one-at-a-time";
  debounceMs?: number;
};
declare function getActiveEmbeddedRunCount(): number;
//#endregion
//#region src/agents/pi-embedded-runner/runs.d.ts
/**
 * Abort embedded PI runs.
 *
 * - With a sessionId, aborts that single run.
 * - With no sessionId, supports targeted abort modes (for example, compacting runs only).
 */
declare function abortEmbeddedPiRun(sessionId: string): boolean;
declare function abortEmbeddedPiRun(sessionId: undefined, opts: {
  mode: "all" | "compacting";
}): boolean;
/**
 * Wait for active embedded runs to drain.
 *
 * Used during restarts so in-flight runs can release session write locks before
 * the next lifecycle starts. If no timeout is passed, waits indefinitely.
 */
declare function waitForActiveEmbeddedRuns(timeoutMs?: number, opts?: {
  pollMs?: number;
}): Promise<{
  drained: boolean;
}>;
declare function setActiveEmbeddedRun(sessionId: string, handle: EmbeddedPiQueueHandle, sessionKey?: string): void;
declare function clearActiveEmbeddedRun(sessionId: string, handle: EmbeddedPiQueueHandle, sessionKey?: string): void;
//#endregion
export { EmbeddedPiQueueMessageOptions as a, waitForActiveEmbeddedRuns as i, clearActiveEmbeddedRun as n, getActiveEmbeddedRunCount as o, setActiveEmbeddedRun as r, abortEmbeddedPiRun as t };