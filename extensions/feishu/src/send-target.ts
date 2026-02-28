import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { resolveReceiveIdType, normalizeFeishuTarget } from "./targets.js";

export function resolveFeishuSendTarget(params: {
  cfg: ClawdbotConfig;
  to: string;
  accountId?: string;
}) {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }
  const client = createFeishuClient(account);
  const receiveId = normalizeFeishuTarget(params.to);
  if (!receiveId) {
    throw new Error(`Invalid Feishu target: ${params.to}`);
  }
  return {
    client,
    receiveId,
    receiveIdType: resolveReceiveIdType(receiveId),
  };
}
