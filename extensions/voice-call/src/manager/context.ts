import type { VoiceCallConfig } from "../config.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { CallId, CallRecord } from "../types.js";

type TranscriptWaiter = {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  turnToken?: string;
};

type CallManagerRuntimeState = {
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  processedEventIds: Set<string>;
  /** Provider call IDs we already sent a reject hangup for; avoids duplicate hangup calls. */
  rejectedProviderCallIds: Set<string>;
};

type CallManagerRuntimeDeps = {
  provider: VoiceCallProvider | null;
  config: VoiceCallConfig;
  storePath: string;
  webhookUrl: string | null;
};

type CallManagerTransientState = {
  activeTurnCalls: Set<CallId>;
  transcriptWaiters: Map<CallId, TranscriptWaiter>;
  maxDurationTimers: Map<CallId, NodeJS.Timeout>;
  initialMessageInFlight: Set<CallId>;
};

/**
 * Lazily issue a per-call stream session (token + WSS URL) for carriers that
 * attach Media Streaming at dial or answer time (e.g. Telnyx). The manager
 * calls this just before delegating to the provider's initiate/answer so the
 * streaming params can be embedded in the carrier API payload.
 *
 * Returns `undefined` when realtime is not configured.
 */
export type StreamSessionIssuer = (request: {
  providerName: "twilio" | "telnyx";
  callId: CallId;
  from?: string;
  to?: string;
  direction: "inbound" | "outbound";
}) => { token: string; streamUrl: string } | undefined;

type CallManagerHooks = {
  /** Optional runtime hook invoked after an event transitions a call into answered state. */
  onCallAnswered?: (call: CallRecord) => void;
  /** Carrier-side stream session issuer; supplied by runtime when realtime is enabled. */
  streamSessionIssuer?: StreamSessionIssuer;
};

export type CallManagerContext = CallManagerRuntimeState &
  CallManagerRuntimeDeps &
  CallManagerTransientState &
  CallManagerHooks;
