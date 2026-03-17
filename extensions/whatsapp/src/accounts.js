import fs from "node:fs";
import path from "node:path";
import { createAccountListHelpers } from "../../../src/channels/plugins/account-helpers.js";
import { resolveOAuthDir } from "../../../src/config/paths.js";
import { resolveAccountEntry } from "../../../src/routing/account-lookup.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../src/routing/session-key.js";
import { resolveUserPath } from "../../../src/utils.js";
import { hasWebCredsSync } from "./auth-store.js";
const DEFAULT_WHATSAPP_MEDIA_MAX_MB = 50;
const { listConfiguredAccountIds, listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("whatsapp");
const listWhatsAppAccountIds = listAccountIds;
const resolveDefaultWhatsAppAccountId = resolveDefaultAccountId;
function listWhatsAppAuthDirs(cfg) {
  const oauthDir = resolveOAuthDir();
  const whatsappDir = path.join(oauthDir, "whatsapp");
  const authDirs = /* @__PURE__ */ new Set([oauthDir, path.join(whatsappDir, DEFAULT_ACCOUNT_ID)]);
  const accountIds = listConfiguredAccountIds(cfg);
  for (const accountId of accountIds) {
    authDirs.add(resolveWhatsAppAuthDir({ cfg, accountId }).authDir);
  }
  try {
    const entries = fs.readdirSync(whatsappDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      authDirs.add(path.join(whatsappDir, entry.name));
    }
  } catch {
  }
  return Array.from(authDirs);
}
function hasAnyWhatsAppAuth(cfg) {
  return listWhatsAppAuthDirs(cfg).some((authDir) => hasWebCredsSync(authDir));
}
function resolveAccountConfig(cfg, accountId) {
  return resolveAccountEntry(cfg.channels?.whatsapp?.accounts, accountId);
}
function resolveDefaultAuthDir(accountId) {
  return path.join(resolveOAuthDir(), "whatsapp", normalizeAccountId(accountId));
}
function resolveLegacyAuthDir() {
  return resolveOAuthDir();
}
function legacyAuthExists(authDir) {
  try {
    return fs.existsSync(path.join(authDir, "creds.json"));
  } catch {
    return false;
  }
}
function resolveWhatsAppAuthDir(params) {
  const accountId = params.accountId.trim() || DEFAULT_ACCOUNT_ID;
  const account = resolveAccountConfig(params.cfg, accountId);
  const configured = account?.authDir?.trim();
  if (configured) {
    return { authDir: resolveUserPath(configured), isLegacy: false };
  }
  const defaultDir = resolveDefaultAuthDir(accountId);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const legacyDir = resolveLegacyAuthDir();
    if (legacyAuthExists(legacyDir) && !legacyAuthExists(defaultDir)) {
      return { authDir: legacyDir, isLegacy: true };
    }
  }
  return { authDir: defaultDir, isLegacy: false };
}
function resolveWhatsAppAccount(params) {
  const rootCfg = params.cfg.channels?.whatsapp;
  const accountId = params.accountId?.trim() || resolveDefaultWhatsAppAccountId(params.cfg);
  const accountCfg = resolveAccountConfig(params.cfg, accountId);
  const enabled = accountCfg?.enabled !== false;
  const { authDir, isLegacy } = resolveWhatsAppAuthDir({
    cfg: params.cfg,
    accountId
  });
  return {
    accountId,
    name: accountCfg?.name?.trim() || void 0,
    enabled,
    sendReadReceipts: accountCfg?.sendReadReceipts ?? rootCfg?.sendReadReceipts ?? true,
    messagePrefix: accountCfg?.messagePrefix ?? rootCfg?.messagePrefix ?? params.cfg.messages?.messagePrefix,
    authDir,
    isLegacyAuthDir: isLegacy,
    selfChatMode: accountCfg?.selfChatMode ?? rootCfg?.selfChatMode,
    dmPolicy: accountCfg?.dmPolicy ?? rootCfg?.dmPolicy,
    allowFrom: accountCfg?.allowFrom ?? rootCfg?.allowFrom,
    groupAllowFrom: accountCfg?.groupAllowFrom ?? rootCfg?.groupAllowFrom,
    groupPolicy: accountCfg?.groupPolicy ?? rootCfg?.groupPolicy,
    textChunkLimit: accountCfg?.textChunkLimit ?? rootCfg?.textChunkLimit,
    chunkMode: accountCfg?.chunkMode ?? rootCfg?.chunkMode,
    mediaMaxMb: accountCfg?.mediaMaxMb ?? rootCfg?.mediaMaxMb,
    blockStreaming: accountCfg?.blockStreaming ?? rootCfg?.blockStreaming,
    ackReaction: accountCfg?.ackReaction ?? rootCfg?.ackReaction,
    groups: accountCfg?.groups ?? rootCfg?.groups,
    debounceMs: accountCfg?.debounceMs ?? rootCfg?.debounceMs
  };
}
function resolveWhatsAppMediaMaxBytes(account) {
  const mediaMaxMb = typeof account.mediaMaxMb === "number" && account.mediaMaxMb > 0 ? account.mediaMaxMb : DEFAULT_WHATSAPP_MEDIA_MAX_MB;
  return mediaMaxMb * 1024 * 1024;
}
function listEnabledWhatsAppAccounts(cfg) {
  return listWhatsAppAccountIds(cfg).map((accountId) => resolveWhatsAppAccount({ cfg, accountId })).filter((account) => account.enabled);
}
export {
  DEFAULT_WHATSAPP_MEDIA_MAX_MB,
  hasAnyWhatsAppAuth,
  listEnabledWhatsAppAccounts,
  listWhatsAppAccountIds,
  listWhatsAppAuthDirs,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
  resolveWhatsAppAuthDir,
  resolveWhatsAppMediaMaxBytes
};
