import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "../runtime-api.js";
import {
  listFeishuAccountIds,
  resolveFeishuAccount,
  resolveFeishuRuntimeAccount,
} from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { resolveToolsConfig } from "./tools-config.js";
import type { FeishuToolsConfig, ResolvedFeishuAccount } from "./types.js";

type AccountAwareParams = { accountId?: string };

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

function resolveImplicitToolAccountId(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: AccountAwareParams;
  defaultAccountId?: string;
}): string | undefined {
  // 1. Explicit accountId from tool call parameters (highest priority)
  const explicitAccountId = normalizeOptionalAccountId(params.executeParams?.accountId);
  if (explicitAccountId) {
    return explicitAccountId;
  }

  // 2. Contextual accountId from message source (e.g., which bot received the message)
  // This takes priority over configured default to ensure correct multi-tenant behavior.
  // See: https://github.com/openclaw/openclaw/issues/59399
  const contextualAccountId = normalizeOptionalAccountId(params.defaultAccountId);
  if (contextualAccountId && listFeishuAccountIds(params.api.config).includes(contextualAccountId)) {
    const contextualAccount = resolveFeishuAccount({
      cfg: params.api.config,
      accountId: contextualAccountId,
    });
    if (contextualAccount.enabled) {
      return contextualAccountId;
    }
  }

  // 3. Configured defaultAccount as fallback (lowest priority)
  const configuredDefaultAccountId = readConfiguredDefaultAccountId(params.api.config);
  if (configuredDefaultAccountId) {
    return configuredDefaultAccountId;
  }

  return undefined;
}

export function resolveFeishuToolAccount(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: AccountAwareParams;
  defaultAccountId?: string;
}): ResolvedFeishuAccount {
  if (!params.api.config) {
    throw new Error("Feishu config unavailable");
  }
  return resolveFeishuRuntimeAccount({
    cfg: params.api.config,
    accountId: resolveImplicitToolAccountId(params),
  });
}

export function createFeishuToolClient(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: AccountAwareParams;
  defaultAccountId?: string;
}): Lark.Client {
  return createFeishuClient(resolveFeishuToolAccount(params));
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
