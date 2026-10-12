import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";

export function resolveConfiguredFeishuAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
}): ReturnType<typeof resolveFeishuRuntimeAccount> {
  const account = resolveFeishuRuntimeAccount(params);
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }
  return account;
}

export function createConfiguredFeishuClient(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
}): ReturnType<typeof createFeishuClient> {
  return createFeishuClient(resolveConfiguredFeishuAccount(params));
}
