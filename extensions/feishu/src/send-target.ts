import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { resolveReceiveIdType, normalizeFeishuTarget } from "./targets.js";

export function resolveFeishuSendTarget(params: {
  cfg: ClawdbotConfig;
  to: string;
  accountId?: string;
}) {
  const target = params.to.trim();
  const account = resolveFeishuRuntimeAccount({ cfg: params.cfg, accountId: params.accountId });
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
  return {
    client,
    receiveId,
    receiveIdType: resolveReceiveIdType(withoutProviderPrefix),
  };
}
