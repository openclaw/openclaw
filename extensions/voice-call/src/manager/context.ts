import type { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { VoiceCallConfig, VoiceCallCoreSessionConfig } from "../config.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { VoiceCallStateRuntime } from "../runtime-state.js";
import type { CallId, CallRecord } from "../types.js";

export type CallEndResult = { success: boolean; error?: string };

type TranscriptWaiter = {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  turnToken?: string;
};

export type CallManagerContext = {
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  processedEventIds: Set<string>;
  /** Provider call IDs reserved for reject hangup; avoids duplicate hangup calls. */
  rejectedProviderCallIds: Map<string, symbol>;
  provider: VoiceCallProvider | null;
  config: VoiceCallConfig;
  coreSession?: VoiceCallCoreSessionConfig;
  storePath: string;
  stateRuntime?: VoiceCallStateRuntime["state"];
  webhookUrl: string | null;
  mutationQueue: KeyedAsyncQueue;
  pendingCallAdmissions: Set<CallId>;
  trackCallWork: (work: Promise<unknown>) => void;
  isStopping: () => boolean;
  activeTurnCalls: Set<CallId>;
  endCallOperations: Map<CallId, Promise<CallEndResult>>;
  transcriptWaiters: Map<CallId, TranscriptWaiter>;
  maxDurationTimers: Map<CallId, NodeJS.Timeout>;
  notifyHangupTimers: Map<CallId, NodeJS.Timeout>;
  initialMessageInFlight: Set<CallId>;
  onCallAnswered?: (call: CallRecord) => void;
  onCallerSpeech?: (call: CallRecord) => void;
  streamSessionIssuer?: StreamSessionIssuer;
};

export type StreamSessionIssuer = (request: {
  providerName: "twilio" | "telnyx";
  callId: CallId;
  from?: string;
  to?: string;
  direction: "inbound" | "outbound";
}) => { token: string; streamUrl: string } | undefined;
