import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { resolveReceiveIdType, normalizeFeishuTarget } from "./targets.js";
function resolveFeishuSendTarget(params) {
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
  const withoutProviderPrefix = target.replace(/^(feishu|lark):/i, "");
  return {
    client,
    receiveId,
    receiveIdType: resolveReceiveIdType(withoutProviderPrefix)
  };
}
export {
  resolveFeishuSendTarget
};
