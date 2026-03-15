import { resolveAccount } from "./accounts.js";
import { DEFAULT_ACCOUNT_ID } from "./constants.js";

export function normalizeWecomAllowFromEntry(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  return trimmed
    .replace(/^(wecom|wework):/i, "")
    .replace(/^user:/i, "")
    .toLowerCase();
}

export function resolveWecomAllowFrom(cfg, accountId) {
  const account = resolveAccount(cfg, accountId);
  if (!account) return [];

  const accountCfg = account.config;
  const allowFromRaw = accountCfg?.dm?.allowFrom ?? accountCfg?.allowFrom ?? [];

  if (!Array.isArray(allowFromRaw)) {
    return [];
  }

  return allowFromRaw.map(normalizeWecomAllowFromEntry).filter((entry) => Boolean(entry));
}

export function resolveWecomCommandAuthorized({ cfg, accountId, senderId }) {
  const sender = String(senderId ?? "")
    .trim()
    .toLowerCase();
  if (!sender) {
    return false;
  }

  const allowFrom = resolveWecomAllowFrom(cfg, accountId);
  if (allowFrom.includes("*") || allowFrom.length === 0) {
    return true;
  }
  return allowFrom.includes(sender);
}
