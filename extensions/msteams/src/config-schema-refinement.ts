import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

type MSTeamsCloud = "Public" | "USGov" | "USGovDoD" | "China";

type MSTeamsRefinementAccount = {
  enabled?: boolean;
  appId?: string;
  appPassword?: unknown;
  tenantId?: string;
  cloud?: MSTeamsCloud;
  serviceUrl?: string;
  authType?: "secret" | "federated";
  certificatePath?: string;
  useManagedIdentity?: boolean;
  webhook?: { port?: number };
  dmPolicy?: string;
  allowFrom?: Array<string | number>;
  sso?: { enabled?: boolean; connectionName?: string };
};

type MSTeamsRefinementConfig = MSTeamsRefinementAccount & {
  accounts?: Record<string, MSTeamsRefinementAccount | undefined>;
};

function isAzureChinaBotFrameworkServiceUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return host === "botframework.azure.cn" || host.endsWith(".botframework.azure.cn");
  } catch {
    return false;
  }
}

export function refineMSTeamsConfig(value: MSTeamsRefinementConfig, ctx: z.RefinementCtx): void {
  const webhookPorts = new Map<number, string>();
  const appIds = new Map<string, string>();
  const recordWebhookPort = (port: number | undefined, path: Array<string | number>) => {
    if (typeof port !== "number") {
      return;
    }
    const existing = webhookPorts.get(port);
    if (existing) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `Microsoft Teams webhook port ${port} is already used by ${existing}`,
      });
      return;
    }
    webhookPorts.set(port, path.join("."));
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

  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.msteams.dmPolicy="open" requires channels.msteams.allowFrom to include "*"',
  });
  requireAllowlistAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.msteams.dmPolicy="allowlist" requires channels.msteams.allowFrom to contain at least one sender ID',
  });
  if (value.sso?.enabled === true && !value.sso.connectionName?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sso", "connectionName"],
      message:
        "channels.msteams.sso.enabled=true requires channels.msteams.sso.connectionName to identify the Bot Framework OAuth connection",
    });
  }
  if (
    value.cloud &&
    value.cloud !== "Public" &&
    value.cloud !== "China" &&
    !value.serviceUrl?.trim()
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["serviceUrl"],
      message:
        "channels.msteams.cloud requires channels.msteams.serviceUrl for non-public Teams clouds",
    });
  }
  if (
    value.cloud === "China" &&
    value.serviceUrl?.trim() &&
    !isAzureChinaBotFrameworkServiceUrl(value.serviceUrl)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["serviceUrl"],
      message:
        "channels.msteams.cloud=China requires channels.msteams.serviceUrl to use an Azure China Bot Framework channel host",
    });
  }
  if (
    value.cloud !== "China" &&
    value.serviceUrl?.trim() &&
    isAzureChinaBotFrameworkServiceUrl(value.serviceUrl)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cloud"],
      message: "Azure China Bot Framework serviceUrl hosts require channels.msteams.cloud=China",
    });
  }

  const rootDefaultIdentityFields = [value.appId, value.appPassword, value.webhook?.port].some(
    (field) => field !== undefined && field !== null && field !== "",
  );
  const defaultAccountKey = accountKeys.get(DEFAULT_ACCOUNT_ID);
  const accountsDefault = defaultAccountKey ? value.accounts?.[defaultAccountKey] : undefined;
  const accountsDefaultPath = ["accounts", defaultAccountKey ?? DEFAULT_ACCOUNT_ID];
  const accountsDefaultIdentityFields = [
    accountsDefault?.appId,
    accountsDefault?.appPassword,
    accountsDefault?.webhook?.port,
  ].some((field) => field !== undefined && field !== null && field !== "");
  if (rootDefaultIdentityFields && accountsDefaultIdentityFields) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: accountsDefaultPath,
      message:
        "channels.msteams can define the default Teams identity either at the root or in accounts.default, not both",
    });
  }

  const rootDefaultAccountEnabled = value.enabled !== false && accountsDefault?.enabled !== false;
  if (rootDefaultAccountEnabled && rootDefaultIdentityFields) {
    recordWebhookPort(value.webhook?.port ?? 3978, ["webhook", "port"]);
  }
  if (
    accountsDefault?.enabled !== false &&
    accountsDefaultIdentityFields &&
    accountsDefault?.webhook?.port === undefined
  ) {
    recordWebhookPort(3978, ["accounts", "default", "webhook", "port"]);
  }
  if (rootDefaultAccountEnabled) {
    recordAppId(value.appId, ["appId"]);
  }

  for (const [accountId, account] of Object.entries(value.accounts ?? {})) {
    if (!account) {
      continue;
    }
    const canonicalAccountId = normalizeAccountId(accountId);
    const path = ["accounts", accountId];
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

    if (account.sso?.enabled === true && !account.sso.connectionName?.trim()) {
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

    const accountEnabled = value.enabled !== false && account.enabled !== false;
    if (canonicalAccountId !== DEFAULT_ACCOUNT_ID && accountEnabled) {
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
      if (effectiveAuthType === "secret" && !account.appPassword) {
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
      if (account.webhook?.port === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "webhook", "port"],
          message:
            "channels.msteams.accounts.*.webhook.port is required for named Microsoft Teams bot accounts",
        });
      }
    }
    if (accountEnabled) {
      recordAppId(account.appId, [...path, "appId"]);
      recordWebhookPort(account.webhook?.port, [...path, "webhook", "port"]);
    }
  }
}
