import type { OpenClawConfig } from "openclaw/plugin-sdk";

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
  config: Record<string, unknown>;
};

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

  return {
    accountId: params.accountId ?? "default",
    name,
    enabled,
    configured: enabled, // Configured if enabled (CLI must be running externally or auto-started)
    wsUrl: `ws://${wsHost}:${wsPort}`,
    wsPort,
    wsHost,
    dmPolicy: (simplexCfg.dmPolicy as "open" | "pairing") ?? "pairing",
    allowFrom: (simplexCfg.allowFrom as string[]) ?? [],
    cliPath: (simplexCfg.cliPath as string) ?? null,
    dbPath: (simplexCfg.dbPath as string) ?? null,
    autoStart: (simplexCfg.autoStart as boolean) ?? false,
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
