import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { resolveToolsConfig } from "./tools-config.js";
function normalizeOptionalAccountId(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : void 0;
}
function readConfiguredDefaultAccountId(config) {
  const value = config?.channels?.feishu?.defaultAccount;
  if (typeof value !== "string") {
    return void 0;
  }
  return normalizeOptionalAccountId(value);
}
function resolveFeishuToolAccount(params) {
  if (!params.api.config) {
    throw new Error("Feishu config unavailable");
  }
  return resolveFeishuAccount({
    cfg: params.api.config,
    accountId: normalizeOptionalAccountId(params.executeParams?.accountId) ?? readConfiguredDefaultAccountId(params.api.config) ?? normalizeOptionalAccountId(params.defaultAccountId)
  });
}
function createFeishuToolClient(params) {
  return createFeishuClient(resolveFeishuToolAccount(params));
}
function resolveAnyEnabledFeishuToolsConfig(accounts) {
  const merged = {
    doc: false,
    chat: false,
    wiki: false,
    drive: false,
    perm: false,
    scopes: false
  };
  for (const account of accounts) {
    const cfg = resolveToolsConfig(account.config.tools);
    merged.doc = merged.doc || cfg.doc;
    merged.chat = merged.chat || cfg.chat;
    merged.wiki = merged.wiki || cfg.wiki;
    merged.drive = merged.drive || cfg.drive;
    merged.perm = merged.perm || cfg.perm;
    merged.scopes = merged.scopes || cfg.scopes;
  }
  return merged;
}
export {
  createFeishuToolClient,
  resolveAnyEnabledFeishuToolsConfig,
  resolveFeishuToolAccount
};
