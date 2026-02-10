import type { RemoteInfo } from "node:dgram";
import type { VoiceCallConfig } from "../../config.js";
import type { MediaGraph } from "./ari-media.js";

type AriConfigInner = NonNullable<VoiceCallConfig["asteriskAri"]>;
export type AriConfig = AriConfigInner;

// Minimal ARI REST types we use
export type AriChannel = {
  id: string;
  name?: string;
  state?: string;
  dialplan?: { app_name?: string; app_data?: string };
  caller?: { number?: string; name?: string };
};

export type AriBridge = {
  id: string;
  channels?: string[];
};

export type AriEndpointState = {
  state: string;
};

export type CoreSttSession = {
  onAudio: (mulaw: Buffer) => void;
  close: () => void;
};

export type CallState = {
  callId: string;
  providerCallId: string;
  sipChannelId: string;
  media?: MediaGraph;
  speaking: boolean;
  ttsTimer?: NodeJS.Timeout;
  stt?: CoreSttSession;
  sttMessageHandler?: (msg: Buffer) => void;
  rtpMessageHandler?: (msg: Buffer, rinfo: RemoteInfo) => void;
  pendingMulaw?: Buffer;
  pendingSpeakText?: string;
  rtpPeer?: { address: string; port: number };
  answeredEmitted?: boolean;
  rtpSeen?: boolean;
  rtpState?: { seq: number; ts: number; ssrc: number };
};
