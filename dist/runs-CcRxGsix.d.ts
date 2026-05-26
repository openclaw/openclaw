import { a as SourceReplyDeliveryMode } from "./get-reply-options.types-DiZecFJG.js";

//#region src/agents/pi-embedded-runner/run-state.d.ts
type EmbeddedPiQueueHandle = {
  kind?: "embedded";
  queueMessage: (text: string, options?: EmbeddedPiQueueMessageOptions) => Promise<void>;
  isStreaming: () => boolean;
  isCompacting: () => boolean;
  supportsTranscriptCommitWait?: boolean;
  cancel?: (reason?: "user_abort" | "restart" | "superseded") => void;
  abort: () => void;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
};
type EmbeddedPiQueueMessageOptions = {
  steeringMode?: "all";
  debounceMs?: number;
  deliveryTimeoutMs?: number;
  waitForTranscriptCommit?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
};
declare function getActiveEmbeddedRunCount(): number;
declare function listActiveEmbeddedRunSessionKeys(): string[];
declare function listActiveEmbeddedRunSessionIds(): string[];
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
declare function resolveActiveEmbeddedRunSessionId(sessionKey: string): string | undefined;
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
export { waitForActiveEmbeddedRuns as a, listActiveEmbeddedRunSessionIds as c, setActiveEmbeddedRun as i, listActiveEmbeddedRunSessionKeys as l, clearActiveEmbeddedRun as n, EmbeddedPiQueueMessageOptions as o, resolveActiveEmbeddedRunSessionId as r, getActiveEmbeddedRunCount as s, abortEmbeddedPiRun as t };