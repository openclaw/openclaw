import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { resolveFeishuAccount, resolveFeishuRuntimeAccount } from "./accounts.js";
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
  const explicitAccountId = normalizeOptionalAccountId(params.executeParams?.accountId);
  if (explicitAccountId) {
    return explicitAccountId;
  }

  const configuredDefaultAccountId = readConfiguredDefaultAccountId(params.api.config);
  if (configuredDefaultAccountId) {
    return configuredDefaultAccountId;
  }

  const contextualAccountId = normalizeOptionalAccountId(params.defaultAccountId);
  if (!contextualAccountId) {
    return undefined;
  }

  const contextualAccount = resolveFeishuAccount({
    cfg: params.api.config,
    accountId: contextualAccountId,
  });
  if (contextualAccount.enabled && contextualAccount.configured) {
    return contextualAccountId;
  }

  // Tool contexts often pass agent ids here. If that id does not resolve to a
  // configured Feishu account, fall back to the normal default-account
  // selection instead of erroring on a synthetic account name.
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
