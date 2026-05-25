import type { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveSlackAccount } from "./accounts.js";
import { createSlackWebClient } from "./client.js";

/**
 * Slack `apps.manifest.*` admin actions. These mutate the workspace app
 * definition itself (create / update / export / validate) and require a
 * Slack *app configuration* token (xoxe.xoxp-...) — distinct from the bot
 * token and the user token.
 *
 * Gated by `channels.slack.actions.appManifest === true` (default off) and
 * requires `channels.slack.appConfigToken` to be set.
 *
 * Note: Slack's app configuration tokens come with a refresh-token pair and
 * eventually expire. The current implementation expects a static token value
 * and surfaces auth errors back to the caller; automatic refresh-token
 * rotation is not implemented here. Operators are expected to rotate the
 * secret out-of-band before it expires.
 */

export type SlackAppConfigClientOpts = {
  cfg?: OpenClawConfig;
  accountId?: string;
  /** Explicit token override. When omitted, the resolved app config token is used. */
  token?: string;
  client?: WebClient;
};

function resolveAppConfigToken(
  explicit: string | undefined,
  accountId: string | undefined,
  cfg: OpenClawConfig | undefined,
  scope: string,
): string {
  const trimmedExplicit = explicit?.trim();
  if (trimmedExplicit) {
    return trimmedExplicit;
  }
  if (!cfg) {
    throw new Error(
      `Slack app-manifest action (${scope}) requires a resolved runtime config. ` +
        `Load and resolve config at the command or gateway boundary, then pass cfg ` +
        `through the runtime path.`,
    );
  }
  const resolvedCfg = requireRuntimeConfig(cfg, `Slack app-manifest action (${scope})`);
  const account = resolveSlackAccount({ cfg: resolvedCfg, accountId });
  const token = (account.config.appConfigToken ?? "").trim();
  if (!token) {
    logVerbose(
      `slack app-manifest: missing appConfigToken for ${scope} account=${account.accountId}`,
    );
    throw new Error(
      `Slack app-manifest action ${scope} requires channels.slack.appConfigToken to be set.`,
    );
  }
  return token;
}

async function getAppConfigClient(
  opts: SlackAppConfigClientOpts,
  scope: string,
): Promise<WebClient> {
  if (opts.client) {
    return opts.client;
  }
  const token = resolveAppConfigToken(opts.token, opts.accountId, opts.cfg, scope);
  return createSlackWebClient(token);
}

function ensurePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object describing the Slack app manifest.`);
  }
  return value as Record<string, unknown>;
}

export type SlackManifestCreateResult = {
  appId?: string;
  credentials?: Record<string, unknown>;
  oauthAuthorizeUrl?: string;
};

export async function createSlackAppManifest(
  manifest: unknown,
  opts: SlackAppConfigClientOpts = {},
): Promise<SlackManifestCreateResult> {
  const manifestJson = ensurePlainObject(manifest, "Slack manifest");
  const client = await getAppConfigClient(opts, "apps.manifest.create");
  const result = (await client.apiCall("apps.manifest.create", {
    manifest: JSON.stringify(manifestJson),
  })) as Record<string, unknown>;
  return {
    appId: typeof result.app_id === "string" ? result.app_id : undefined,
    credentials:
      result.credentials && typeof result.credentials === "object"
        ? (result.credentials as Record<string, unknown>)
        : undefined,
    oauthAuthorizeUrl:
      typeof result.oauth_authorize_url === "string" ? result.oauth_authorize_url : undefined,
  };
}

export type SlackManifestUpdateResult = {
  appId?: string;
  permissionsUpdated?: boolean;
};

export async function updateSlackAppManifest(
  appId: string,
  manifest: unknown,
  opts: SlackAppConfigClientOpts = {},
): Promise<SlackManifestUpdateResult> {
  const trimmedAppId = appId.trim();
  if (!trimmedAppId) {
    throw new Error("Slack apps.manifest.update requires an appId.");
  }
  const manifestJson = ensurePlainObject(manifest, "Slack manifest");
  const client = await getAppConfigClient(opts, "apps.manifest.update");
  const result = (await client.apiCall("apps.manifest.update", {
    app_id: trimmedAppId,
    manifest: JSON.stringify(manifestJson),
  })) as Record<string, unknown>;
  return {
    appId: typeof result.app_id === "string" ? result.app_id : trimmedAppId,
    permissionsUpdated:
      typeof result.permissions_updated === "boolean" ? result.permissions_updated : undefined,
  };
}

export type SlackManifestExportResult = {
  appId: string;
  manifest: Record<string, unknown>;
};

export async function exportSlackAppManifest(
  appId: string,
  opts: SlackAppConfigClientOpts = {},
): Promise<SlackManifestExportResult> {
  const trimmedAppId = appId.trim();
  if (!trimmedAppId) {
    throw new Error("Slack apps.manifest.export requires an appId.");
  }
  const client = await getAppConfigClient(opts, "apps.manifest.export");
  const result = (await client.apiCall("apps.manifest.export", {
    app_id: trimmedAppId,
  })) as Record<string, unknown>;
  const manifest = ensurePlainObject(result.manifest, "Slack manifest export result");
  return {
    appId: trimmedAppId,
    manifest,
  };
}

export type SlackManifestValidateResult = {
  ok: boolean;
  errors?: unknown;
};

export async function validateSlackAppManifest(
  manifest: unknown,
  opts: SlackAppConfigClientOpts & { appId?: string } = {},
): Promise<SlackManifestValidateResult> {
  const manifestJson = ensurePlainObject(manifest, "Slack manifest");
  const trimmedAppId = opts.appId?.trim();
  const client = await getAppConfigClient(opts, "apps.manifest.validate");
  const result = (await client.apiCall("apps.manifest.validate", {
    manifest: JSON.stringify(manifestJson),
    ...(trimmedAppId ? { app_id: trimmedAppId } : {}),
  })) as Record<string, unknown>;
  return {
    ok: result.ok === true,
    ...(result.errors !== undefined ? { errors: result.errors } : {}),
  };
}
