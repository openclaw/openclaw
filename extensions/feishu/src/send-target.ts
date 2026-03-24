import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { resolveReceiveIdType, normalizeFeishuTarget } from "./targets.js";
import type { FeishuIdType } from "./types.js";

export function resolveFeishuSendTarget(params: {
  cfg: ClawdbotConfig;
  to: string;
  accountId?: string;
}) {
  const target = params.to.trim();
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }
  const client = createFeishuClient(account);
  const receiveId = normalizeFeishuTarget(target);
  if (!receiveId) {
    throw new Error(`Invalid Feishu target: ${params.to}`);
  }
  // Preserve explicit routing prefixes (chat/group/user/dm/open_id) when present.
  // normalizeFeishuTarget strips these prefixes, so infer type from the raw target first.
  const withoutProviderPrefix = target.replace(/^(feishu|lark):/i, "");
  const receiveIdType = resolveReceiveIdType(withoutProviderPrefix);
  if (!receiveIdType) {
    throw new Error(`Cannot resolve Feishu ID type for target: ${params.to}`);
  }
  return {
    client,
    receiveId,
    receiveIdType: receiveIdType as FeishuIdType,
  };
}
