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
  /** @deprecated Prefer `resolveFeishuToolAccountFromContext({ toolContext })`. */
  defaultAccountId?: string;
  /** @deprecated Prefer `resolveFeishuToolAccountFromContext({ toolContext })`. */
  messageChannel?: string;
}): ResolvedFeishuAccount {
  if (!params.api.config) {
    throw new Error("Feishu config unavailable");
  }
  return resolveFeishuAccount({
    cfg: params.api.config,
    accountId:
      normalizeOptionalAccountId(params.executeParams?.accountId) ??
      // Only trust routed account context for Feishu-originated sessions.
      (isFeishuMessageChannel(params.messageChannel) &&
      isKnownFeishuAccountId(params.api.config, params.defaultAccountId)
        ? normalizeOptionalAccountId(params.defaultAccountId)
        : undefined) ??
      readConfiguredDefaultAccountId(params.api.config) ??
      // Preserve legacy behavior for callers that still pass defaultAccountId
      // without messageChannel/context wiring.
      (params.messageChannel == null
        ? normalizeOptionalAccountId(params.defaultAccountId)
        : undefined),
  });
}

export function resolveFeishuToolAccountFromContext(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: AccountAwareParams;
  toolContext?: FeishuToolRuntimeContext;
}): ResolvedFeishuAccount {
  return resolveFeishuToolAccount({
    api: params.api,
    executeParams: params.executeParams,
    defaultAccountId: params.toolContext?.agentAccountId,
    messageChannel: params.toolContext?.messageChannel,
  });
}

export function createFeishuToolClient(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: AccountAwareParams;
  /** @deprecated Prefer `createFeishuToolClientFromContext({ toolContext })`. */
  defaultAccountId?: string;
  /** @deprecated Prefer `createFeishuToolClientFromContext({ toolContext })`. */
  messageChannel?: string;
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
