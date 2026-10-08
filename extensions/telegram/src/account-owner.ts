import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";

export function resolveTelegramAccountOwnerAgentId(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string {
  const { cfg, accountId } = params;
  return resolveAgentRoute({ cfg, channel: "telegram", accountId }).agentId;
}
