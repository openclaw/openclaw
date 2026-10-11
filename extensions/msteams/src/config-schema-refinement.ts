import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { isHttpsUrlAllowedByHostnameSuffixAllowlist } from "openclaw/plugin-sdk/ssrf-policy";
import { canonicalizeWebhookRouteKey } from "openclaw/plugin-sdk/webhook-targets";
import { z } from "zod";
import type { MSTeamsConfig } from "../runtime-api.js";
import { resolveMSTeamsWebhookPath } from "./accounts-webhook.js";

type MSTeamsRefinementAccount = Pick<
  MSTeamsConfig,
  | "enabled"
  | "appId"
  | "appPassword"
  | "tenantId"
  | "cloud"
  | "serviceUrl"
  | "authType"
  | "certificatePath"
  | "useManagedIdentity"
  | "webhook"
  | "dmPolicy"
  | "allowFrom"
  | "sso"
>;

type MSTeamsRefinementConfig = MSTeamsRefinementAccount & {
  accounts?: Record<string, MSTeamsRefinementAccount | undefined>;
};

function hasConfiguredValue(value: unknown): boolean {
  return typeof value === "string"
    ? value.trim().length > 0
    : value !== undefined && value !== null;
}

function hasEnvironmentBackedDefaultCredentials(value: MSTeamsRefinementConfig): boolean {
  const hasAppId =
    hasConfiguredValue(value.appId) || hasConfiguredValue(process.env.MSTEAMS_APP_ID);
  const hasTenantId =
    hasConfiguredValue(value.tenantId) || hasConfiguredValue(process.env.MSTEAMS_TENANT_ID);
  const authType = value.authType ?? process.env.MSTEAMS_AUTH_TYPE ?? "secret";
  if (authType === "federated") {
    const hasCertificate =
      hasConfiguredValue(value.certificatePath) ||
      hasConfiguredValue(process.env.MSTEAMS_CERTIFICATE_PATH);
    const usesManagedIdentity =
      value.useManagedIdentity ?? process.env.MSTEAMS_USE_MANAGED_IDENTITY === "true";
    return hasAppId && hasTenantId && (hasCertificate || usesManagedIdentity);
  }
  const hasPassword =
    hasConfiguredValue(value.appPassword) || hasConfiguredValue(process.env.MSTEAMS_APP_PASSWORD);
  return hasAppId && hasTenantId && hasPassword;
}

function isAzureChinaBotFrameworkServiceUrl(value: string): boolean {
  return isHttpsUrlAllowedByHostnameSuffixAllowlist(value.trim(), ["botframework.azure.cn"]);
}

export function refineMSTeamsConfig(value: MSTeamsRefinementConfig, ctx: z.RefinementCtx): void {
  const webhookPaths = new Map<string, string>();
  const appIds = new Map<string, string>();
  const recordWebhookPath = (webhookPath: string, path: Array<string | number>) => {
    const canonical = canonicalizeWebhookRouteKey(webhookPath);
    const existing = webhookPaths.get(canonical);
    if (existing) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `Microsoft Teams webhook path ${webhookPath} is already used by ${existing}`,
      });
    } else {
      webhookPaths.set(canonical, path.join("."));
    }
  };
  const recordAppId = (appId: string | undefined, path: Array<string | number>) => {
    const normalized = appId?.trim().toLowerCase();
    if (!normalized) {
      return;
    }
    const existing = appIds.get(normalized);
    if (existing) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `Microsoft Teams appId is already used by ${existing}`,
      });
      return;
    }
    appIds.set(normalized, path.join("."));
  };
  const accountKeys = new Map<string, string>();
  for (const accountId of Object.keys(value.accounts ?? {})) {
    const canonicalAccountId = normalizeAccountId(accountId);
    const existing = accountKeys.get(canonicalAccountId);
    if (existing) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accounts", accountId],
        message:
          `channels.msteams.accounts contains duplicate canonical account id "${canonicalAccountId}" ` +
          `from "${existing}" and "${accountId}"`,
      });
      continue;
    }
    accountKeys.set(canonicalAccountId, accountId);
  }

  const rootDefaultIdentityFields = [value.appId, value.appPassword].some(
    (field) => field !== undefined && field !== null && field !== "",
  );
  const defaultAccountKey = accountKeys.get(DEFAULT_ACCOUNT_ID);
  const accountsDefault = defaultAccountKey ? value.accounts?.[defaultAccountKey] : undefined;
  const accountsDefaultPath = ["accounts", defaultAccountKey ?? DEFAULT_ACCOUNT_ID];
  const accountsDefaultIdentityFields = [accountsDefault?.appId, accountsDefault?.appPassword].some(
    (field) => field !== undefined && field !== null && field !== "",
  );
  const effectiveDefault = {
    ...value,
    ...accountsDefault,
    sso: { ...value.sso, ...accountsDefault?.sso },
  };
  const hasEnvironmentDefaultCredentials = hasEnvironmentBackedDefaultCredentials(effectiveDefault);
  if (rootDefaultIdentityFields && accountsDefaultIdentityFields) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: accountsDefaultPath,
      message:
        "channels.msteams can define the default Teams identity either at the root or in accounts.default, not both",
    });
  }

  const rootDefaultAccountEnabled = value.enabled !== false && accountsDefault?.enabled !== false;
  const defaultAccountConfigured =
    rootDefaultIdentityFields ||
    accountsDefaultIdentityFields ||
    hasEnvironmentDefaultCredentials ||
    accountKeys.size === 0;
  const effectiveDefaultAppId = hasConfiguredValue(accountsDefault?.appId)
    ? accountsDefault?.appId
    : hasConfiguredValue(value.appId)
      ? value.appId
      : process.env.MSTEAMS_APP_ID;
  if (rootDefaultAccountEnabled && defaultAccountConfigured) {
    const defaultPath = accountsDefault ? accountsDefaultPath : [];
    const effectiveDmPolicy = effectiveDefault.dmPolicy;
    const effectiveAllowFrom = effectiveDefault.allowFrom;
    requireOpenAllowFrom({
      policy: effectiveDmPolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: [...defaultPath, "allowFrom"],
      message:
        'The effective default Microsoft Teams account dmPolicy="open" requires allowFrom to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: effectiveDmPolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: [...defaultPath, "allowFrom"],
      message:
        'The effective default Microsoft Teams account dmPolicy="allowlist" requires allowFrom to contain at least one sender ID',
    });

    const effectiveSso = effectiveDefault.sso;
    if (effectiveSso.enabled === true && !effectiveSso.connectionName?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...defaultPath, "sso", "connectionName"],
        message:
          "The effective default Microsoft Teams account sso.enabled=true requires sso.connectionName to identify the Bot Framework OAuth connection",
      });
    }

    const effectiveCloud = effectiveDefault.cloud;
    const effectiveServiceUrl = effectiveDefault.serviceUrl;
    if (
      effectiveCloud &&
      effectiveCloud !== "Public" &&
      effectiveCloud !== "China" &&
      !effectiveServiceUrl?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...defaultPath, "serviceUrl"],
        message:
          "The effective default Microsoft Teams account cloud requires serviceUrl for non-public Teams clouds",
      });
    }
    if (
      effectiveCloud === "China" &&
      effectiveServiceUrl?.trim() &&
      !isAzureChinaBotFrameworkServiceUrl(effectiveServiceUrl)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...defaultPath, "serviceUrl"],
        message:
          "The effective default Microsoft Teams account cloud=China requires serviceUrl to use an Azure China Bot Framework channel host",
      });
    }
    if (
      effectiveCloud !== "China" &&
      effectiveServiceUrl?.trim() &&
      isAzureChinaBotFrameworkServiceUrl(effectiveServiceUrl)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...defaultPath, "cloud"],
        message:
          "Azure China Bot Framework serviceUrl hosts require the effective default Microsoft Teams account cloud=China",
      });
    }
  }
  if (rootDefaultAccountEnabled && defaultAccountConfigured) {
    recordAppId(effectiveDefaultAppId, ["appId"]);
    recordWebhookPath(resolveMSTeamsWebhookPath(value, DEFAULT_ACCOUNT_ID, accountsDefault), [
      ...(accountsDefault ? accountsDefaultPath : []),
      "webhook",
      "path",
    ]);
  }

  for (const [accountId, account] of Object.entries(value.accounts ?? {})) {
    if (!account) {
      continue;
    }
    const canonicalAccountId = normalizeAccountId(accountId);
    const path = ["accounts", accountId];
    if (canonicalAccountId === DEFAULT_ACCOUNT_ID) {
      continue;
    }
    const accountEnabled = value.enabled !== false && account.enabled !== false;
    if (!accountEnabled) {
      continue;
    }
    const effectiveDmPolicy = account.dmPolicy ?? value.dmPolicy;
    const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
    requireOpenAllowFrom({
      policy: effectiveDmPolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: [...path, "allowFrom"],
      message:
        'channels.msteams.accounts.*.dmPolicy="open" requires channels.msteams.accounts.*.allowFrom (or channels.msteams.allowFrom) to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: effectiveDmPolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: [...path, "allowFrom"],
      message:
        'channels.msteams.accounts.*.dmPolicy="allowlist" requires channels.msteams.accounts.*.allowFrom (or channels.msteams.allowFrom) to contain at least one sender ID',
    });

    const effectiveSso = { ...value.sso, ...account.sso };
    if (effectiveSso.enabled === true && !effectiveSso.connectionName?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "sso", "connectionName"],
        message:
          "channels.msteams.accounts.*.sso.enabled=true requires sso.connectionName to identify the Bot Framework OAuth connection",
      });
    }

    const effectiveCloud = account.cloud ?? value.cloud;
    const effectiveServiceUrl = account.serviceUrl ?? value.serviceUrl;
    if (
      effectiveCloud &&
      effectiveCloud !== "Public" &&
      effectiveCloud !== "China" &&
      !effectiveServiceUrl?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "serviceUrl"],
        message:
          "channels.msteams.accounts.*.cloud requires serviceUrl for non-public Teams clouds",
      });
    }
    if (
      effectiveCloud === "China" &&
      effectiveServiceUrl?.trim() &&
      !isAzureChinaBotFrameworkServiceUrl(effectiveServiceUrl)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "serviceUrl"],
        message:
          "channels.msteams.accounts.*.cloud=China requires serviceUrl to use an Azure China Bot Framework channel host",
      });
    }
    if (
      effectiveCloud !== "China" &&
      effectiveServiceUrl?.trim() &&
      isAzureChinaBotFrameworkServiceUrl(effectiveServiceUrl)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "cloud"],
        message:
          "Azure China Bot Framework serviceUrl hosts require channels.msteams.accounts.*.cloud=China",
      });
    }

    if (!account.appId?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "appId"],
        message:
          "channels.msteams.accounts.*.appId is required for named Microsoft Teams bot accounts",
      });
    }
    if (!(account.tenantId ?? value.tenantId)?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "tenantId"],
        message:
          "channels.msteams.accounts.*.tenantId or channels.msteams.tenantId is required for named Microsoft Teams bot accounts",
      });
    }
    const effectiveAuthType = account.authType ?? value.authType ?? "secret";
    if (effectiveAuthType === "secret" && !hasConfiguredValue(account.appPassword)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "appPassword"],
        message:
          "channels.msteams.accounts.*.appPassword is required for named Microsoft Teams bot accounts using secret auth",
      });
    }
    if (
      effectiveAuthType === "federated" &&
      !(account.certificatePath ?? value.certificatePath)?.trim() &&
      (account.useManagedIdentity ?? value.useManagedIdentity) !== true
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "authType"],
        message:
          "channels.msteams.accounts.* using federated auth must configure certificatePath or useManagedIdentity",
      });
    }
    recordAppId(account.appId, [...path, "appId"]);
    recordWebhookPath(resolveMSTeamsWebhookPath(value, canonicalAccountId, account), [
      ...path,
      "webhook",
      "path",
    ]);
  }
}
