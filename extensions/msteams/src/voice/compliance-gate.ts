/**
 * Hard runtime gate for recording compliance.
 *
 * Microsoft requires calling `updateRecordingStatus` on a call before any
 * media data can be persisted or derived (transcription, recording, etc.).
 * The .NET media worker calls `updateRecordingStatus` after the call reaches
 * "Established" state, then emits a ComplianceEvent via gRPC.
 *
 * This gate ensures NO audio data is processed by the TS agent plane until
 * compliance is confirmed. Audio received before that point is discarded.
 */

import type { ComplianceState } from "./types.js";

export class ComplianceGate {
  private states = new Map<string, ComplianceState>();

  /**
   * Update the compliance state for a call. Called when the .NET worker
   * emits a ComplianceEvent via the gRPC SubscribeEvents stream.
   */
  handleComplianceEvent(callId: string, status: ComplianceState): void {
    this.states.set(callId, status);
  }

  /**
   * Assert that audio processing is allowed for the given call.
   * Throws if compliance is not in the "active" state.
   *
   * Use this as a guard before feeding audio into the STT pipeline.
   */
  assertCompliant(callId: string): void {
    const state = this.states.get(callId);
    if (state !== "active") {
      throw new Error(
        `Recording compliance not active for call ${callId} (state: ${state ?? "unknown"}). ` +
          "Audio processing is blocked until updateRecordingStatus succeeds.",
      );
    }
  }

  /** Check if audio processing is allowed without throwing. */
  isCompliant(callId: string): boolean {
    return this.states.get(callId) === "active";
  }

  /** Get the current compliance state for a call. */
  getState(callId: string): ComplianceState | undefined {
    return this.states.get(callId);
  }

  /** Remove tracking for a call (cleanup on hangup/terminate). */
  remove(callId: string): void {
    this.states.delete(callId);
  }

  /** Clear all tracked states (shutdown). */
  clear(): void {
    this.states.clear();
  }
}
