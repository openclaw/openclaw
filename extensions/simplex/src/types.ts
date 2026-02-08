import type { SimplexAccountConfig } from "./config-schema.js";

export type SimplexConnectionMode = "managed" | "external";

export type SimplexConnectionConfig = {
  mode?: SimplexConnectionMode;
  wsUrl?: string;
  wsHost?: string;
  wsPort?: number;
  cliPath?: string;
  dataDir?: string;
  autoAcceptFiles?: boolean;
  connectTimeoutMs?: number;
};

export type ResolvedSimplexAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  mode: SimplexConnectionMode;
  wsUrl: string;
  wsHost: string;
  wsPort: number;
  cliPath: string;
  dataDir?: string;
  config: SimplexAccountConfig;
};
