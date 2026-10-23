/**
 * Leaf contract for the read path's per-attempt skill-instruction delivery
 * markers. Kept beside `agent-tools.read.js` but free of its implementation
 * imports, so shared hook-contract types (`agent-tools.before-tool-call.types`)
 * can reference the marker shape without entering the read implementation's
 * import cycle.
 */
export type SkillInstructionDeliveryMarkers = {
  /** Capture this invocation's skill.used emission marker from a settled delivery. */
  captureInvocationFingerprint(toolCallId: string, fingerprint: string): void;
  /** Consume this invocation's emission marker; absent when unestablishable. */
  takeInvocationFingerprint(toolCallId: string): string | undefined;
  /** Drop an invocation's marker when its delivery failed or was reset. */
  deleteInvocationFingerprint(toolCallId: string): void;
  /** Epoch clear: drop unconsumed markers together with the delivery cache. */
  clear(): void;
  /** Monotonic epoch generation; clear() advances it. */
  generation(): number;
};
