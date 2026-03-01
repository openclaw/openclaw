import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { SimplexUserRouting, SimplexGroupRouting } from "./config-schema.js";

export type ResolvedSimplexAccount = {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  wsUrl: string;
  wsPort: number;
  wsHost: string;
  dmPolicy: "open" | "pairing";
  allowFrom: string[];
  cliPath: string | null;
  dbPath: string | null;
  autoStart: boolean;
  /** Member IDs to filter out (e.g., own bot's IDs) */
  filterMemberIds: string[];
  /** Display names to filter out */
  filterDisplayNames: string[];
  /** User routing configuration */
  userRouting: SimplexUserRouting[];
  /** Group routing configuration */
  groupRouting: SimplexGroupRouting[];
  /** Default agent for unmatched contacts */
  defaultAgent?: string;
  /** Default language */
  defaultLanguage: string;
  /** Default model */
  defaultModel?: string;
  /** Default voice replies */
  defaultVoiceReplies: boolean;
  /** Store conversation history */
  storeHistory: boolean;
  /** Max stored history */
  maxStoredHistory: number;
  config: Record<string, unknown>;
};

/**
 * SimpleX WebSocket protocol minimal types.
 * These cover commonly-observed messages from the simplex-chat CLI.
 */

export type SimplexWsRequest = {
  corrId?: string; // optional correlation id
  cmd?: string; // CLI command (send, file, pairing, etc)
  action?: string; // alternative field name used by some versions
  args?: Record<string, unknown>;
};

export type SimplexWsResponse = {
  corrId?: string;
  type: string; // eg: "ok", "error", "newChatItems", "pairingRequest", "fileReady"
  payload?: unknown;
  error?: string;
};

export type SimplexChatItem = {
  id: string;
  from?: string | null;
  to?: string[] | null;
  body?: string | null;
  timestamp: number; // unix ms
  type: "text" | "file" | "image" | "voice" | "system";
  fileId?: string;
  fileName?: string;
  mime?: string;
};

export type SimplexContact = {
  id: string; // opaque contact id
  label?: string; // user-provided name
  paired: boolean;
  createdAt?: number;
};

export type SimplexGroup = {
  id: string | number;
  name?: string;
  members?: string[];
};

// Re-export SimplexMessage from simplex-bus for external use
export type { SimplexMessage } from "./simplex-bus.js";

/**
 * Resolve SimpleX account from config.
 */
export function resolveSimplexAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedSimplexAccount {
  const channels = (params.cfg.channels ?? {}) as Record<string, Record<string, unknown>>;
  const simplexCfg = channels.simplex ?? {};

  const wsHost = (simplexCfg.wsHost as string) ?? "127.0.0.1";
  const wsPort = (simplexCfg.wsPort as number) ?? 5225;
  const enabled = (simplexCfg.enabled as boolean) ?? true;
  const name = (simplexCfg.name as string) ?? "SimpleX";

  const wsUrl = (simplexCfg.wsUrl as string) ?? `ws://${wsHost}:${wsPort}`;

  return {
    accountId: params.accountId ?? "default",
    name,
    enabled,
    configured: enabled,
    wsUrl,
    wsPort,
    wsHost,
    dmPolicy: (simplexCfg.dmPolicy as "open" | "pairing") ?? "pairing",
    allowFrom: (simplexCfg.allowFrom as string[]) ?? [],
    cliPath: (simplexCfg.cliPath as string) ?? null,
    dbPath: (simplexCfg.dbPath as string) ?? null,
    autoStart: (simplexCfg.autoStart as boolean) ?? false,
    filterMemberIds: (simplexCfg.filterMemberIds as string[]) ?? [],
    filterDisplayNames: (simplexCfg.filterDisplayNames as string[]) ?? [],
    userRouting: (simplexCfg.userRouting as SimplexUserRouting[]) ?? [],
    groupRouting: (simplexCfg.groupRouting as SimplexGroupRouting[]) ?? [],
    defaultAgent: simplexCfg.defaultAgent as string | undefined,
    defaultLanguage: (simplexCfg.defaultLanguage as string) ?? "en",
    defaultModel: simplexCfg.defaultModel as string | undefined,
    defaultVoiceReplies: (simplexCfg.defaultVoiceReplies as boolean) ?? false,
    storeHistory: (simplexCfg.storeHistory as boolean) ?? true,
    maxStoredHistory: (simplexCfg.maxStoredHistory as number) ?? 50,
    config: simplexCfg,
  };
}

/**
 * List SimpleX account IDs (currently single-account only).
 */
export function listSimplexAccountIds(_cfg: OpenClawConfig): string[] {
  return ["default"];
}

/**
 * Resolve default SimpleX account ID.
 */
export function resolveDefaultSimplexAccountId(_cfg: OpenClawConfig): string {
  return "default";
}
