import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import type { SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { hasSlackAccountCredentials } from "./account-configured.js";
import {
  buildSlackAccountSurfaceFields,
  type SlackAccountSurfaceFields,
} from "./account-surface-fields.js";
import {
  mergeSlackAccountConfig,
  resolveDefaultSlackAccountId,
  type SlackTokenSource,
} from "./accounts.js";

export type SlackCredentialStatus = "available" | "configured_unavailable" | "missing";

export type InspectedSlackAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  mode?: SlackAccountConfig["mode"];
  botToken?: string;
  appToken?: string;
  signingSecret?: string;
  userToken?: string;
  botTokenSource: SlackTokenSource;
  appTokenSource: SlackTokenSource;
  signingSecretSource?: SlackTokenSource;
  userTokenSource: SlackTokenSource;
  botTokenStatus: SlackCredentialStatus;
  appTokenStatus: SlackCredentialStatus;
  signingSecretStatus?: SlackCredentialStatus;
  userTokenStatus: SlackCredentialStatus;
  configured: boolean;
  identity?: "user";
  config: SlackAccountConfig;
} & SlackAccountSurfaceFields;

function inspectSlackToken(
  value: unknown,
  envToken?: string,
): {
  token?: string;
  source: SlackTokenSource;
  status: SlackCredentialStatus;
} {
  const token = normalizeSecretInputString(value);
  if (token || hasConfiguredSecretInput(value)) {
    return {
      token,
      source: "config",
      status: token ? "available" : "configured_unavailable",
    };
  }
  // A configured SecretRef stays authoritative while unavailable.
  return envToken
    ? { token: envToken, source: "env", status: "available" }
    : { source: "none", status: "missing" };
}

export function inspectSlackAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  envBotToken?: string | null;
  envAppToken?: string | null;
  envUserToken?: string | null;
}): InspectedSlackAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSlackAccountId(params.cfg),
  );
  const merged = mergeSlackAccountConfig(params.cfg, accountId);
  const enabled = params.cfg.channels?.slack?.enabled !== false && merged.enabled !== false;
  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const mode = merged.mode ?? "socket";
  const identity = merged.postAs ?? "bot";
  const isHttpMode = mode === "http";
  const isSocketMode = mode === "socket";

  const envBot = allowEnv
    ? normalizeSecretInputString(params.envBotToken ?? process.env.SLACK_BOT_TOKEN)
    : undefined;
  const envApp =
    allowEnv && isSocketMode
      ? normalizeSecretInputString(params.envAppToken ?? process.env.SLACK_APP_TOKEN)
      : undefined;
  const envUser = allowEnv
    ? normalizeSecretInputString(params.envUserToken ?? process.env.SLACK_USER_TOKEN)
    : undefined;

  const botCredential = inspectSlackToken(merged.botToken, envBot);
  const appCredential = inspectSlackToken(isSocketMode ? merged.appToken : undefined, envApp);
  const configSigningSecret = inspectSlackToken(merged.signingSecret);
  const userCredential = inspectSlackToken(merged.userToken, envUser);

  return {
    accountId,
    enabled,
    ...(identity === "user" ? { identity } : {}),
    name: normalizeOptionalString(merged.name),
    mode,
    botToken: botCredential.token,
    appToken: appCredential.token,
    ...(isHttpMode ? { signingSecret: configSigningSecret.token } : {}),
    userToken: userCredential.token,
    botTokenSource: botCredential.source,
    appTokenSource: appCredential.source,
    ...(isHttpMode ? { signingSecretSource: configSigningSecret.source } : {}),
    userTokenSource: userCredential.source,
    botTokenStatus: botCredential.status,
    appTokenStatus: appCredential.status,
    ...(isHttpMode ? { signingSecretStatus: configSigningSecret.status } : {}),
    userTokenStatus: userCredential.status,
    configured: hasSlackAccountCredentials({
      config: merged,
      identityTokenConfigured:
        (identity === "user" ? userCredential : botCredential).status !== "missing",
      appTokenConfigured: appCredential.status !== "missing",
    }),
    config: merged,
    ...buildSlackAccountSurfaceFields(merged),
  };
}
