import { createScopedChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import type { OpenClawConfig, ResolvedLineAccount } from "../api.js";
import { getLineRuntime } from "./runtime.js";

function resolveLineRuntimeAccount(cfg: OpenClawConfig, accountId?: string | null) {
  return getLineRuntime().channel.line.resolveLineAccount({
    cfg,
    accountId: accountId ?? undefined,
  });
}

export function normalizeLineAllowFrom(entry: string): string {
  return entry.replace(/^line:(?:user:)?/i, "");
}

export const lineConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedLineAccount,
  ResolvedLineAccount,
  OpenClawConfig
>({
  sectionKey: "line",
  listAccountIds: (cfg) => getLineRuntime().channel.line.listLineAccountIds(cfg),
  resolveAccount: (cfg, accountId) => resolveLineRuntimeAccount(cfg, accountId),
  defaultAccountId: (cfg) => getLineRuntime().channel.line.resolveDefaultLineAccountId(cfg),
  clearBaseFields: ["channelSecret", "tokenFile", "secretFile"],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    allowFrom
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map(normalizeLineAllowFrom),
});
