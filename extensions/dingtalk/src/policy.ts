// 类型定义
interface ClawdbotConfig {
  [key: string]: any;
}

interface ToolPolicy {
  allow?: string[];
  deny?: string[];
}
import { resolveDingtalkAccount } from "./config/accounts.ts";

export function resolveDingtalkGroupToolPolicy(params: {
  cfg: ClawdbotConfig;
  groupId?: string | null;
  accountId?: string | null;
}): ToolPolicy | undefined {
  const { cfg, groupId, accountId } = params;

  const account = resolveDingtalkAccount({ cfg, accountId });
  const dingtalkCfg = account.config;

  // Check group-specific policy first
  if (groupId) {
    const groupConfig = dingtalkCfg?.groups?.[groupId];
    if (groupConfig?.tools) {
      return groupConfig.tools;
    }
  }

  // Fall back to account-level default (allow all)
  return { allow: ["*"] };
}
