import type * as Lark from "@larksuiteoapi/node-sdk";
import type { ClawdbotConfig, OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { FeishuToolsConfig, ResolvedFeishuAccount } from "../types.js";
import {
  listEnabledFeishuAccounts,
  resolveDefaultFeishuAccountId,
  resolveFeishuAccount,
} from "../accounts.js";
import { createFeishuClient } from "../client.js";
import { resolveToolsConfig } from "../tools-config.js";
import { getCurrentFeishuToolContext } from "./tool-context.js";

export type FeishuToolFlag = keyof Required<FeishuToolsConfig>;

export function hasFeishuToolEnabledForAnyAccount(
  cfg: ClawdbotConfig,
  requiredTool?: FeishuToolFlag,
): boolean {
  // Tool registration is global (one definition), so we only need to know whether
  // at least one enabled account can use the tool.
  const accounts = listEnabledFeishuAccounts(cfg);
  if (accounts.length === 0) {
    return false;
  }
  if (!requiredTool) {
    return true;
  }
  return accounts.some((account) => resolveToolsConfig(account.config.tools)[requiredTool]);
}

export function resolveToolAccount(cfg: ClawdbotConfig): ResolvedFeishuAccount {
  const context = getCurrentFeishuToolContext();
  if (context?.channel === "feishu" && context.accountId) {
    // Message-driven path: use the account from AsyncLocalStorage context.
    return resolveFeishuAccount({ cfg, accountId: context.accountId });
  }
  // Non-session path (e.g. background/manual invocation): fall back to default account.
  return resolveFeishuAccount({ cfg, accountId: resolveDefaultFeishuAccountId(cfg) });
}

export async function withFeishuToolClient<T>(params: {
  api: OpenClawPluginApi;
  toolName: string;
  requiredTool?: FeishuToolFlag;
  run: (args: { client: Lark.Client; account: ResolvedFeishuAccount }) => Promise<T>;
}): Promise<T> {
  if (!params.api.config) {
    throw new Error("Feishu config is not available");
  }

  // Resolve account at execution time (not registration time).
  const account = resolveToolAccount(params.api.config);

  if (!account.enabled) {
    throw new Error(`Feishu account "${account.accountId}" is disabled`);
  }
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" is not configured`);
  }

  if (params.requiredTool) {
    // Enforce per-account tool toggles, even though the tool is registered globally.
    const toolsCfg = resolveToolsConfig(account.config.tools);
    if (!toolsCfg[params.requiredTool]) {
      throw new Error(
        `Feishu tool "${params.toolName}" is disabled for account "${account.accountId}"`,
      );
    }
  }

  const client = createFeishuClient(account);
  return params.run({ client, account });
}
