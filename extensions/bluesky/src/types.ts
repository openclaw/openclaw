export type BlueskyChannelConfig = {
  enabled?: boolean;
  handle?: string;
  appPassword?: string;
  /** Personal Data Server URL — defaults to https://bsky.social */
  pdsUrl?: string;
  /** Explicit default account id used when no accountId is supplied to outbound sends. */
  defaultAccount?: string;
  accounts?: Record<string, BlueskyAccountConfig>;
};

export type BlueskyAccountConfig = {
  enabled?: boolean;
  handle?: string;
  appPassword?: string;
  pdsUrl?: string;
};

export type ResolvedBlueskyAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  handle: string;
  appPassword: string;
  pdsUrl: string;
};
