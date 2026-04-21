import type { VoiceCallConfig } from "../config.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { CallId, CallRecord } from "../types.js";

export type TranscriptWaiter = {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  turnToken?: string;
};

export type CallManagerRuntimeState = {
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  processedEventIds: Set<string>;
  /** Provider call IDs we already sent a reject hangup for; avoids duplicate hangup calls. */
  rejectedProviderCallIds: Set<string>;
};

export type CallManagerRuntimeDeps = {
  provider: VoiceCallProvider | null;
  config: VoiceCallConfig;
  storePath: string;
  webhookUrl: string | null;
};

export type CallManagerTransientState = {
  activeTurnCalls: Set<CallId>;
  transcriptWaiters: Map<CallId, TranscriptWaiter>;
  maxDurationTimers: Map<CallId, NodeJS.Timeout>;
  initialMessageInFlight: Set<CallId>;
};

export type CallManagerHooks = {
  /** Optional runtime hook invoked after an event transitions a call into answered state. */
  onCallAnswered?: (call: CallRecord) => void;
  /**
   * Optional runtime hook invoked once a call has fully transitioned into a
   * terminal state (after `finalizeCall`). Receives a snapshot of the call
   * record including the full transcript collected during the call. Used by
   * the runtime to relay post-call transcripts into the agent reasoning loop.
   * Hooks must not throw — wrap the body in try/catch.
   */
  onCallEnded?: (call: CallRecord) => void;
};

export type CallManagerContext = CallManagerRuntimeState &
  CallManagerRuntimeDeps &
  CallManagerTransientState &
  CallManagerHooks;
