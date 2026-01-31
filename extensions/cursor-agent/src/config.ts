import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { CursorAgentAccountConfig } from "./types.js";
import { CursorAgentConfigSchema, type CursorAgentConfig } from "./config-schema.js";

export const DEFAULT_ACCOUNT_ID = "default";

/**
 * Get Cursor Agent configuration from OpenClaw config.
 */
export function getCursorAgentConfig(cfg: OpenClawConfig): CursorAgentConfig | null {
  const channels = (cfg as Record<string, unknown>).channels as Record<string, unknown> | undefined;
  const cursorAgent = channels?.cursorAgent;
  if (!cursorAgent) {
    return null;
  }

  const parsed = CursorAgentConfigSchema.safeParse(cursorAgent);
  return parsed.success ? parsed.data : null;
}

/**
 * List all configured account IDs.
 */
export function listAccountIds(cfg: OpenClawConfig): string[] {
  const config = getCursorAgentConfig(cfg);
  if (!config?.accounts) {
    return [];
  }
  return Object.keys(config.accounts);
}

/**
 * Get account configuration by ID.
 */
export function getAccountConfig(
  cfg: OpenClawConfig,
  accountId: string = DEFAULT_ACCOUNT_ID,
): CursorAgentAccountConfig | null {
  const config = getCursorAgentConfig(cfg);
  if (!config?.accounts) {
    return null;
  }
  return (config.accounts[accountId] as CursorAgentAccountConfig) ?? null;
}

/**
 * Check if account is configured and valid.
 */
export function isAccountConfigured(account: CursorAgentAccountConfig | null): boolean {
  if (!account) {
    return false;
  }
  return !!account.apiKey && account.apiKey.length > 0;
}
