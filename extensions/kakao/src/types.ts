export type KakaoAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** If false, do not start this KakaoWork account. Default: true. */
  enabled?: boolean;
  /** Bot App Key from KakaoWork admin console. */
  appKey?: string;
  /** Path to file containing the app key. */
  keyFile?: string;
  /** Callback URL for receiving reactive events (HTTPS required). */
  callbackUrl?: string;
  /** Callback path for the gateway HTTP server (defaults to callback URL path). */
  callbackPath?: string;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  /** Allowlist for DM senders (KakaoWork user IDs). */
  allowFrom?: Array<string | number>;
  /** Max inbound media size in MB. */
  mediaMaxMb?: number;
  /** Proxy URL for API requests. */
  proxy?: string;
};

export type KakaoConfig = {
  /** Optional per-account KakaoWork configuration (multi-account). */
  accounts?: Record<string, KakaoAccountConfig>;
  /** Default account ID when multiple accounts are configured. */
  defaultAccount?: string;
} & KakaoAccountConfig;

export type KakaoTokenSource = "env" | "config" | "configFile" | "none";

export type ResolvedKakaoAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  appKey: string;
  tokenSource: KakaoTokenSource;
  config: KakaoAccountConfig;
};
