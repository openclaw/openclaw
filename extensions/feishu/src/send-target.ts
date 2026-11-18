import type { ClawdbotConfig } from "../runtime-api.js";
import { createConfiguredFeishuClient } from "./configured-client.js";
import { resolveReceiveIdType, normalizeFeishuTarget } from "./targets.js";

type FeishuSendTarget = {
  client: ReturnType<typeof createConfiguredFeishuClient>;
  receiveId: string;
  receiveIdType: ReturnType<typeof resolveReceiveIdType>;
};

export function resolveFeishuSendTarget(params: {
  cfg: ClawdbotConfig;
  to: string;
  accountId?: string;
}): FeishuSendTarget {
  const target = params.to.trim();
  const client = createConfiguredFeishuClient(params);
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
