import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";

type PumbleThreadBindingsFlags = {
  enabled: boolean;
  spawnSubagentSessions: boolean;
  ttlHours?: number;
};

type PumbleActionsFlags = {
  reactions: boolean;
};

type PumbleAccountCfgRaw = Record<string, unknown> | undefined;

function readPumbleCfg(cfg: OpenClawConfig): PumbleAccountCfgRaw {
  return cfg.channels?.pumble as PumbleAccountCfgRaw;
}

function readAccountCfg(cfg: OpenClawConfig, accountId: string): PumbleAccountCfgRaw {
  const pumble = readPumbleCfg(cfg);
  if (!pumble) return undefined;
  const accounts = pumble.accounts as Record<string, PumbleAccountCfgRaw> | undefined;
  return accounts?.[accountId];
}

function readThreadBindings(
  raw: PumbleAccountCfgRaw,
): Partial<PumbleThreadBindingsFlags> | undefined {
  if (!raw) return undefined;
  const tb = raw.threadBindings;
  if (!tb || typeof tb !== "object") return undefined;
  const obj = tb as Record<string, unknown>;
  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : undefined,
    spawnSubagentSessions:
      typeof obj.spawnSubagentSessions === "boolean" ? obj.spawnSubagentSessions : undefined,
    ttlHours: typeof obj.ttlHours === "number" ? obj.ttlHours : undefined,
  };
}

function readActionsFlags(raw: PumbleAccountCfgRaw): Partial<PumbleActionsFlags> | undefined {
  if (!raw) return undefined;
  const actions = raw.actions;
  if (!actions || typeof actions !== "object") return undefined;
  const obj = actions as Record<string, unknown>;
  return {
    reactions: typeof obj.reactions === "boolean" ? obj.reactions : undefined,
  };
}

/**
 * Resolve thread binding flags with account > base > session > default cascade.
 */
export function resolvePumbleThreadBindingsConfig(
  cfg: OpenClawConfig,
  accountId?: string,
): PumbleThreadBindingsFlags {
  const normalizedId = normalizeAccountId(accountId);
  const baseTb = readThreadBindings(readPumbleCfg(cfg));
  const accountTb = readThreadBindings(readAccountCfg(cfg, normalizedId));
  const sessionTb = readThreadBindings(cfg.session as PumbleAccountCfgRaw);

  return {
    enabled: accountTb?.enabled ?? baseTb?.enabled ?? sessionTb?.enabled ?? true,
    spawnSubagentSessions:
      accountTb?.spawnSubagentSessions ?? baseTb?.spawnSubagentSessions ?? false,
    ttlHours: accountTb?.ttlHours ?? baseTb?.ttlHours,
  };
}

/**
 * Resolve actions flags with account > base cascade.
 */
export function resolvePumbleActionsConfig(
  cfg: OpenClawConfig,
  accountId?: string,
): PumbleActionsFlags {
  const normalizedId = normalizeAccountId(accountId);
  const baseActions = readActionsFlags(readPumbleCfg(cfg));
  const accountActions = readActionsFlags(readAccountCfg(cfg, normalizedId));

  return {
    reactions: accountActions?.reactions ?? baseActions?.reactions ?? true,
  };
}
