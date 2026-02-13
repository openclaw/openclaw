import type { RemoteInfo } from "node:dgram";
import type { VoiceCallConfig } from "../../config.js";
import type { MediaGraph } from "./ari-media.js";

type AriConfigInner = NonNullable<VoiceCallConfig["asteriskAri"]>;

export type AriConfig = {
  baseUrl: string;
  username: string;
  password: string;
  app: string;
  trunk?: string;
  rtpHost: string;
  rtpPort: number;
  codec: "ulaw" | "alaw";
};

export function requireAriConfig(cfg: AriConfigInner): AriConfig {
  const missing: string[] = [];
  if (!cfg.baseUrl) missing.push("baseUrl");
  if (!cfg.username) missing.push("username");
  if (!cfg.password) missing.push("password");
  if (!cfg.app) missing.push("app");
  if (!cfg.rtpHost) missing.push("rtpHost");
  if (!cfg.rtpPort) missing.push("rtpPort");
  if (!cfg.codec) missing.push("codec");
  if (missing.length) {
    throw new Error(`asteriskAri config missing: ${missing.join(", ")}`);
  }

  const codec = cfg.codec;
  if (codec !== "ulaw" && codec !== "alaw") {
    throw new Error(`asteriskAri codec must be ulaw|alaw (got ${String(codec)})`);
  }

  // After the checks above, we know these are defined.
  return {
    baseUrl: cfg.baseUrl!,
    username: cfg.username!,
    password: cfg.password!,
    app: cfg.app!,
    trunk: cfg.trunk,
    rtpHost: cfg.rtpHost!,
    rtpPort: cfg.rtpPort,
    codec,
  };
}

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
