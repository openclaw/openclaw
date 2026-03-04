import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { detectIdType, resolveReceiveIdType, normalizeFeishuTarget } from "./targets.js";

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
  // Validate the normalized ID has a recognized Feishu format.
  // In shared-session setups (dmScope: "main"), delivery context may be
  // contaminated with IDs from other channels (e.g. "discord:..." or
  // "telegram:..."). Reject early with a clear error instead of letting
  // invalid IDs reach the Feishu API.
  if (detectIdType(receiveId) === null) {
    throw new Error(
      `Invalid Feishu target "${params.to}": not a recognized Feishu ID format (possible cross-channel routing contamination)`,
    );
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
