import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listFeishuAccountIds, resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { resolveToolsConfig } from "./tools-config.js";
import type { FeishuToolsConfig, ResolvedFeishuAccount } from "./types.js";

type AccountAwareParams = { accountId?: string };
type FeishuToolRuntimeContext = {
  agentAccountId?: string;
  messageChannel?: string;
};

function normalizeOptionalAccountId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readConfiguredDefaultAccountId(config: OpenClawPluginApi["config"]): string | undefined {
  const value = (config?.channels?.feishu as { defaultAccount?: unknown } | undefined)
    ?.defaultAccount;
  if (typeof value !== "string") {
    return undefined;
  }
  return normalizeOptionalAccountId(value);
}

function isKnownFeishuAccountId(config: OpenClawPluginApi["config"], accountId?: string): boolean {
  if (!accountId) return false;
  const normalized = accountId.trim().toLowerCase();
  if (!normalized) return false;
  return listFeishuAccountIds(config).some((id) => id.toLowerCase() === normalized);
}

function isFeishuMessageChannel(messageChannel?: string): boolean {
  return messageChannel?.trim().toLowerCase() === "feishu";
}

export function resolveFeishuToolAccount(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: AccountAwareParams;
  defaultAccountId?: string;
}): ResolvedFeishuAccount {
  if (!params.api.config) {
    throw new Error("Feishu config unavailable");
  }
  return resolveFeishuAccount({
    cfg: params.api.config,
    accountId:
      normalizeOptionalAccountId(params.executeParams?.accountId) ??
      readConfiguredDefaultAccountId(params.api.config) ??
      normalizeOptionalAccountId(params.defaultAccountId),
  });
}

/**
 * Channel-aware account resolution.
 * Only trusts the routed `agentAccountId` when the request originates from Feishu
 * and the ID maps to a known Feishu account; otherwise falls back to the
 * configured default. This prevents cross-channel pollution (e.g. a Discord
 * session's accountId colliding with a Feishu account name).
 */
export function resolveFeishuToolAccountFromContext(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: AccountAwareParams;
  toolContext?: FeishuToolRuntimeContext;
}): ResolvedFeishuAccount {
  const routedAccountId = params.toolContext?.agentAccountId;
  const feishuRoutedAccountId =
    isFeishuMessageChannel(params.toolContext?.messageChannel) &&
    isKnownFeishuAccountId(params.api.config, routedAccountId)
      ? routedAccountId
      : undefined;

  const hasExplicitAccountId = !!normalizeOptionalAccountId(params.executeParams?.accountId);
  const mergedExecuteParams: AccountAwareParams | undefined =
    hasExplicitAccountId || !feishuRoutedAccountId
      ? params.executeParams
      : { ...params.executeParams, accountId: feishuRoutedAccountId };

  return resolveFeishuToolAccount({
    api: params.api,
    executeParams: mergedExecuteParams,
  });
}

export function createFeishuToolClient(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: AccountAwareParams;
  defaultAccountId?: string;
}): Lark.Client {
  return createFeishuClient(resolveFeishuToolAccount(params));
}

export function createFeishuToolClientFromContext(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: AccountAwareParams;
  toolContext?: FeishuToolRuntimeContext;
}): Lark.Client {
  return createFeishuClient(resolveFeishuToolAccountFromContext(params));
}

export function resolveAnyEnabledFeishuToolsConfig(
  accounts: ResolvedFeishuAccount[],
): Required<FeishuToolsConfig> {
  const merged: Required<FeishuToolsConfig> = {
    doc: false,
    chat: false,
    wiki: false,
    drive: false,
    perm: false,
    scopes: false,
  };
  for (const account of accounts) {
    const cfg = resolveToolsConfig(account.config.tools);
    merged.doc = merged.doc || cfg.doc;
    merged.chat = merged.chat || cfg.chat;
    merged.wiki = merged.wiki || cfg.wiki;
    merged.drive = merged.drive || cfg.drive;
    merged.perm = merged.perm || cfg.perm;
    merged.scopes = merged.scopes || cfg.scopes;
  }
  return merged;
}
