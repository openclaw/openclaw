import type {
  BaseProbeResult,
  DmPolicy,
  MarkdownConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/pilot";

export type PilotAccountConfig = {
  name?: string;
  enabled?: boolean;
  hostname?: string;
  socketPath?: string;
  registry?: string;
  pilotctlPath?: string;
  pollIntervalMs?: number;
  dmPolicy?: DmPolicy;
  allowFrom?: string[];
  defaultTo?: string;
  markdown?: MarkdownConfig;
  blockStreaming?: boolean;
};

export type PilotConfig = PilotAccountConfig & {
  accounts?: Record<string, PilotAccountConfig>;
  defaultAccount?: string;
};

export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    pilot?: PilotConfig;
  };
};

export type PilotInboundMessage = {
  messageId: string;
  sender: string;
  senderHostname?: string;
  text: string;
  timestamp: number;
};

export type PilotProbe = BaseProbeResult<string> & {
  daemonRunning: boolean;
  address?: string;
  hostname?: string;
  trustedPeers?: number;
  latencyMs?: number;
};

export type PilotPeer = {
  address: string;
  hostname?: string;
  trusted: boolean;
};

export type PilotDaemonStatus = {
  running: boolean;
  address?: string;
  hostname?: string;
  registry?: string;
  uptime?: number;
};

export type PilotTrustRequest = {
  address: string;
  hostname?: string;
  timestamp: number;
};
