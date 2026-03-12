export type WempDmPolicy = "pairing" | "allowlist" | "open" | "disabled";

export interface WempDmConfig {
  policy?: WempDmPolicy;
  allowFrom?: string[];
}

export interface WempRoutingConfig {
  pairedAgent?: string;
  unpairedAgent?: string;
}

export interface WempOutboundConfig {
  retryTimes?: number;
  retryCount?: number;
  retries?: number;
  retryDelayMs?: number;
  retryDelay?: number;
}

export interface WempVoiceTranscribeConfig {
  endpoint?: string;
}

export interface WempMenuItem {
  name: string;
  type: "click" | "view";
  key?: string;
  url?: string;
}

export interface WempRouteGuardConfig {
  enabled?: boolean;
  unpairedAllowedAgents?: string[];
}

export interface WempHandoffTicketWebhookConfig {
  enabled?: boolean;
  endpoint?: string;
  token?: string;
  events?: Array<"activated" | "resumed">;
}

export interface WempFeatureFlags {
  menu?: { enabled?: boolean; items?: WempMenuItem[] };
  assistantToggle?: { enabled?: boolean; defaultEnabled?: boolean };
  usageLimit?: {
    enabled?: boolean;
    dailyMessages?: number;
    dailyTokens?: number;
    exemptPaired?: boolean;
  };
  routeGuard?: WempRouteGuardConfig;
  handoff?: {
    enabled?: boolean;
    contact?: string;
    message?: string;
    autoResumeMinutes?: number;
    activeReply?: string;
    ticketWebhook?: WempHandoffTicketWebhookConfig;
  };
  welcome?: { enabled?: boolean; subscribeText?: string };
}

export type ResolvedWempFeatureFlags = Omit<Required<WempFeatureFlags>, "routeGuard"> & {
  routeGuard?: WempRouteGuardConfig;
};

export interface WempAccountConfig {
  enabled?: boolean;
  name?: string;
  appId?: string;
  appSecret?: string;
  token?: string;
  encodingAESKey?: string;
  webhookPath?: string;
  requireHttps?: boolean;
  dm?: WempDmConfig;
  routing?: WempRoutingConfig;
  outbound?: WempOutboundConfig;
  voiceTranscribe?: WempVoiceTranscribeConfig;
  outboundRetryTimes?: number;
  outboundRetryCount?: number;
  outboundRetries?: number;
  outboundRetryDelayMs?: number;
  outboundRetryDelay?: number;
}

export interface WempChannelConfig extends WempAccountConfig {
  defaultAccount?: string;
  accounts?: Record<string, WempAccountConfig>;
  features?: WempFeatureFlags;
}

export interface ResolvedWempAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  appId: string;
  appSecret: string;
  token: string;
  encodingAESKey?: string;
  webhookPath: string;
  requireHttps?: boolean;
  dm: Required<WempDmConfig>;
  routing: Required<WempRoutingConfig>;
  features: ResolvedWempFeatureFlags;
  config: WempAccountConfig;
}

export interface WempRuntimeSnapshot {
  accountId: string;
  running: boolean;
  connected: boolean;
  lastConnectedAt: number | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  lastError: string | null;
}

export interface WempScaffoldAnswers {
  brandName: string;
  audience: string;
  services: string;
  contact: string;
  escalationRules: string;
  tone: string;
  template: "enterprise" | "content" | "general";
}

// TODO [P2-8]: Move usage-limit to core framework rate-limiting layer
// TODO [P3-16]: Add multi-instance token management (Redis / distributed lock)
// TODO [P3-18]: Add circuit breaker pattern for WeChat API unavailability
