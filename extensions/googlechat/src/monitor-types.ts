// Googlechat plugin module implements monitor types behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatAudienceType } from "./auth.js";
import type { getGoogleChatRuntime } from "./runtime.js";
import type { GoogleChatEvent } from "./types.js";

export type GoogleChatRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type GoogleChatMonitorOptions = {
  account: ResolvedGoogleChatAccount;
  config: OpenClawConfig;
  runtime: GoogleChatRuntimeEnv;
  abortSignal: AbortSignal;
  webhookPath?: string;
  webhookUrl?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type GoogleChatCoreRuntime = ReturnType<typeof getGoogleChatRuntime>;

export type WebhookTarget = {
  account: ResolvedGoogleChatAccount;
  config: OpenClawConfig;
  runtime: GoogleChatRuntimeEnv;
  core: GoogleChatCoreRuntime;
  path: string;
  audienceType?: GoogleChatAudienceType;
  audience?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  mediaMaxMb: number;
  /**
   * Durable admission for MESSAGE events. The webhook journals through this
   * seam before acking Google; the owning monitor drains and disposes it.
   */
  ingress: {
    enqueue: (event: GoogleChatEvent) => Promise<{ kind: string; duplicate: boolean }>;
  };
};
