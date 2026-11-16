import type {
  RealtimeVoiceBridgeSession,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
  ResolvedRealtimeVoiceProvider,
} from "openclaw/plugin-sdk/realtime-voice";
import type { CallRecord } from "../types.js";

export type RealtimeCallRegistration = {
  agentId: string;
  instructions: string;
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  capabilities?: ResolvedRealtimeVoiceProvider["capabilities"];
};

export type ResolveRealtimeCallRegistration = (
  call: CallRecord,
) => RealtimeCallRegistration | Promise<RealtimeCallRegistration>;

export type RealtimeMediaTransport = {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send: (message: string) => void;
  close: (code?: number, reason?: string) => void;
};
export class RealtimeCallCleanupError extends Error {
  constructor() {
    super("Realtime provider/transcript cleanup failed");
  }
}

export type RealtimeRoomTransportParams = {
  callId: string;
  providerCallId: string;
  streamId: string;
  transport: RealtimeMediaTransport;
};

export type RealtimeRoomBinding = {
  sendAudio: (audio: Buffer) => void;
  /** Carrier-owned disposal, without joining a manager termination that may call back here. */
  endCall: () => Promise<void>;
  acknowledgeMark: (name: string) => void;
};

export type RealtimeCallEndCause = "completed" | "disconnect" | "shutdown" | "inactivity" | "error";

// Each socket keeps its exact binding; the call map only grants current-generation
// record termination. Replacement can retire old audio without a late close killing its successor.
export type RealtimeTelephonyBinding = {
  bridge: RealtimeVoiceBridgeSession;
  acknowledgeCarrierMark: (markName?: string) => void;
  close: (cause?: RealtimeCallEndCause) => Promise<void>;
  endCall: () => Promise<void>;
  noteMediaActivity: () => void;
  playVoicemail: (instructions: string) => Promise<void>;
  retire: () => void;
};
