import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { WeComConfig, ResolvedWeComAccount } from "./types.js";

export function listWeComAccountIds(cfg: ClawdbotConfig): string[] {
  const wecomCfg = cfg.channels?.wecom as WeComConfig | undefined;
  if (!wecomCfg) return [];
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultWeComAccountId(cfg: ClawdbotConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

export function resolveWeComAccount({
  cfg,
  accountId,
}: {
  cfg: ClawdbotConfig;
  accountId?: string;
}): ResolvedWeComAccount {
  const id = accountId ?? DEFAULT_ACCOUNT_ID;
  const wecomCfg = cfg.channels?.wecom as WeComConfig | undefined;

  if (!wecomCfg) {
    return {
      accountId: id,
      enabled: false,
      configured: false,
      name: "default",
    };
  }

  const enabled = wecomCfg.enabled ?? false;
  const configured = !!(
    wecomCfg.corpId &&
    wecomCfg.agentId &&
    wecomCfg.secret &&
    wecomCfg.token &&
    wecomCfg.encodingAESKey
  );

  return {
    accountId: id,
    enabled,
    configured,
    name: "default",
    corpId: wecomCfg.corpId,
    agentId: wecomCfg.agentId,
    config: wecomCfg,
  };
}

export function resolveWeComCredentials({
  cfg,
  accountId,
}: {
  cfg: ClawdbotConfig;
  accountId?: string;
}): {
  corpId: string;
  agentId: string;
  secret: string;
  token?: string;
  encodingAESKey?: string;
} {
  const account = resolveWeComAccount({ cfg, accountId });
  const wecomCfg = account.config;

  if (!wecomCfg?.corpId || !wecomCfg?.agentId || !wecomCfg?.secret) {
    throw new Error("WeCom credentials not configured");
  }

  return {
    corpId: wecomCfg.corpId,
    agentId: wecomCfg.agentId,
    secret: wecomCfg.secret,
    token: wecomCfg.token,
    encodingAESKey: wecomCfg.encodingAESKey,
  };
}
