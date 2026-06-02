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
  /** Live call records and provider-id indexes that survive across manager helper calls. */
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  /** Provider event IDs already applied; webhook retries must not re-run side effects. */
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
  /** Calls currently executing an agent turn; drives overlap suppression for voice loops. */
  activeTurnCalls: Set<CallId>;
  /** Pending transcript waits keyed by call; process-local and intentionally not persisted. */
  transcriptWaiters: Map<CallId, TranscriptWaiter>;
  /** Provider-independent call duration deadlines; restored calls rebuild these from persisted age. */
  maxDurationTimers: Map<CallId, NodeJS.Timeout>;
  /** Outbound initial messages already started; prevents duplicate playback on callback races. */
  initialMessageInFlight: Set<CallId>;
};

/** Issues short-lived media stream credentials for providers that connect by websocket. */
export type StreamSessionIssuer = (request: {
  providerName: "twilio" | "telnyx";
  callId: CallId;
  from?: string;
  to?: string;
  direction: "inbound" | "outbound";
}) => { token: string; streamUrl: string } | undefined;

type CallManagerHooks = {
  onCallAnswered?: (call: CallRecord) => void;
  streamSessionIssuer?: StreamSessionIssuer;
};

/** Shared dependency bag passed to pure call-manager helpers instead of binding to the class. */
export type CallManagerContext = CallManagerRuntimeState &
  CallManagerRuntimeDeps &
  CallManagerTransientState &
  CallManagerHooks;
