import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceCloseReason,
} from "openclaw/plugin-sdk/realtime-voice";
import type { CodexAppServerClient } from "./client.js";
import type { CodexServerNotification } from "./protocol.js";
import type {
  CodexRealtimeAudioPeerCallbacks,
  CodexRealtimeAudioPeerContract,
} from "./realtime-voice-webrtc-peer.runtime.js";
import "./realtime-voice-session.js";

type CodexRealtimeAudioPeerFactory = (
  callbacks: CodexRealtimeAudioPeerCallbacks,
  signal: AbortSignal,
) => Promise<CodexRealtimeAudioPeerContract>;

type RealtimeVoiceSessionTestApi = {
  createBridge(
    client: CodexAppServerClient,
    threadId: string,
    request: RealtimeVoiceBridgeCreateRequest,
    signal: AbortSignal,
    createAudioPeer?: CodexRealtimeAudioPeerFactory,
  ): RealtimeVoiceBridge & {
    readonly completion: { promise: Promise<RealtimeVoiceCloseReason> };
    getFailure(): Error | undefined;
    handleNotification(notification: CodexServerNotification): void;
  };
};

export const realtimeVoiceSessionTesting = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.codexRealtimeVoiceSessionTestApi")
] as RealtimeVoiceSessionTestApi;
