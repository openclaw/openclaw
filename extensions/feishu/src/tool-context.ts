import type * as Lark from "@larksuiteoapi/node-sdk";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuClient } from "./client.js";

/**
 * Resolve the Feishu client for the account that received the message.
 * Falls back to the first enabled account when agentAccountId doesn't match.
 */
export function resolveClientForContext(cfg: ClawdbotConfig, agentAccountId?: string): Lark.Client {
  const accounts = listEnabledFeishuAccounts(cfg);
  const match = agentAccountId ? accounts.find((a) => a.accountId === agentAccountId) : null;
  const account = match ?? accounts[0];
  if (!account) {
    throw new Error("No Feishu accounts configured");
  }
  return createFeishuClient(account);
}
