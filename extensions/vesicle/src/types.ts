import type { DmPolicy, GroupPolicy } from "openclaw/plugin-sdk/setup";

export type { DmPolicy, GroupPolicy } from "openclaw/plugin-sdk/setup";

export type VesicleNetworkConfig = {
  /** Dangerous opt-in for trusted private/internal Vesicle deployments. */
  dangerouslyAllowPrivateNetwork?: boolean;
};

export type VesicleAccountConfig = {
  /** Optional display name for this account. */
  name?: string;
  /** If false, do not start this Vesicle account. Default: true. */
  enabled?: boolean;
  /** Base URL for the Vesicle API, for example http://127.0.0.1:1234. */
  serverUrl?: string;
  /** Bearer token accepted by Vesicle's API middleware. */
  authToken?: string;
  /** Native inbound webhook path exposed by OpenClaw. */
  webhookPath?: string;
  /** HMAC secret used to verify X-Vesicle-Signature on native webhooks. */
  webhookSecret?: string;
  /** Direct message access policy for inbound webhooks. */
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  /** Optional allowlist for group senders. */
  groupAllowFrom?: Array<string | number>;
  /** Group message handling policy. */
  groupPolicy?: GroupPolicy;
  /** Default delivery target for CLI --deliver when no explicit --reply-to is provided. */
  defaultTo?: string;
  /** Per-request timeout for outbound text sends. Default: 30000. */
  sendTimeoutMs?: number;
  /** Per-request timeout for status probes. Default: 10000. */
  probeTimeoutMs?: number;
  /** Outbound text chunk size. Default: 4000. */
  textChunkLimit?: number;
  /** Network policy overrides for same-host or trusted private/internal Vesicle deployments. */
  network?: VesicleNetworkConfig;
};

export type VesicleConfig = VesicleAccountConfig & {
  accounts?: Record<string, Partial<VesicleAccountConfig>>;
  defaultAccount?: string;
};

export type CoreConfig = {
  channels?: {
    vesicle?: VesicleConfig;
  };
  session?: {
    store?: string;
  };
};

export type ResolvedVesicleAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  config: VesicleAccountConfig;
  configured: boolean;
  baseUrl?: string;
};

export type VesicleInboundMessage = {
  messageGuid: string;
  chatGuid: string;
  isGroup?: boolean;
  sender: string;
  service?: string;
  date?: number;
  text: string;
  isFromMe?: boolean;
  rowId?: number | null;
};

export type VesicleCapabilities = {
  text?: boolean;
  attachments?: boolean;
  reactions?: boolean;
  edits?: boolean;
  unsend?: boolean;
  groupManagement?: boolean;
  facetime?: boolean;
};

export type VesicleHealthResponse = {
  service?: string;
  version?: string;
  status?: string;
  detail?: string;
  capabilities?: VesicleCapabilities;
};

export type VesicleMessage = {
  messageGuid?: string;
  chatGuid?: string;
  isGroup?: boolean;
  sender?: string;
  service?: string;
  date?: number;
  text?: string;
  isFromMe?: boolean;
  rowId?: number | null;
};

export type VesicleMessageTextResponse = {
  message?: VesicleMessage;
};

export type VesicleErrorEnvelope = {
  code?: string;
  message?: string;
};

export const DEFAULT_SEND_TIMEOUT_MS = 30_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
export const DEFAULT_WEBHOOK_PATH = "/vesicle-webhook";
