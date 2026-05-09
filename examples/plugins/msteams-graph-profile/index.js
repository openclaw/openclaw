// @ts-check

const PLUGIN_ID = "msteams-graph-profile";
const DEFAULT_DOWNSTREAM_SCOPE = "downstream.access";
const DEFAULT_PROFILE_PATH = "/api/me";

/**
 * @typedef {{ provider: string; audience?: string; scopes?: string[] }} DelegatedAccessTokenRequest
 * @typedef {{ ok: true; token: string; expiresAt?: string; tenantId?: string; userId?: string } | { ok: false; reason?: string }} DelegatedAccessTokenResult
 * @typedef {{ getDelegatedAccessToken(request: DelegatedAccessTokenRequest): Promise<DelegatedAccessTokenResult> }} PluginAuthContext
 * @typedef {{ auth?: PluginAuthContext }} PluginToolContext
 * @typedef {{ config: unknown; registerTool(factory: (ctx: PluginToolContext) => unknown, opts: { name: string; optional?: boolean }): void }} PluginApi
 */

const WhoamiParamsSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export default {
  id: PLUGIN_ID,
  name: "Microsoft Teams Downstream Profile Example",
  description:
    "Example delegated-auth tool that calls a downstream profile API with the signed-in Teams user's token.",
  /** @param {PluginApi} api */
  register(api) {
    api.registerTool(
      /** @param {PluginToolContext} ctx */
      (ctx) => ({
        name: "msteams_whoami",
        label: "Teams user profile",
        description: "Read the signed-in Microsoft Teams user's email through a downstream API.",
        parameters: WhoamiParamsSchema,
        /**
         * @param {string} _toolCallId
         * @param {Record<string, never>} _params
         */
        async execute(_toolCallId, _params) {
          const config = resolveDownstreamProfileConfig(api.config);
          if (!config.ok) {
            return {
              content: [
                {
                  type: "text",
                  text: `msteams_whoami is not configured: ${config.reason}`,
                },
              ],
              details: { ok: false, reason: "missing_config", missing: config.missing },
            };
          }

          if (!ctx.auth) {
            return {
              content: [
                {
                  type: "text",
                  text: "Microsoft Teams delegated auth unavailable: auth_context_missing. The tool is available, but OpenClaw did not attach a runtime delegated-auth context to this tool execution.",
                },
              ],
              details: { ok: false, reason: "auth_context_missing" },
            };
          }

          const auth = await ctx.auth.getDelegatedAccessToken({
            provider: "msteams",
            audience: config.value.audience,
            scopes: [config.value.scope],
          });

          if (!auth.ok) {
            return {
              content: [
                {
                  type: "text",
                  text: `Microsoft Teams delegated auth unavailable: ${auth.reason ?? "unavailable"}`,
                },
              ],
              details: { ok: false, reason: auth.reason ?? "unavailable" },
            };
          }

          const response = await fetch(resolveProfileUrl(config.value), {
            headers: {
              authorization: `Bearer ${auth.token}`,
              accept: "application/json",
            },
          });

          if (!response.ok) {
            return {
              content: [
                {
                  type: "text",
                  text: `Downstream profile API failed: HTTP ${response.status}`,
                },
              ],
              details: { ok: false, status: response.status },
            };
          }

          const profile = await response.json();
          const email =
            readString(profile.email) ||
            readString(profile.mail) ||
            readString(profile.userPrincipalName) ||
            "unknown";
          const displayName = readString(profile.displayName) || "unknown";

          return {
            content: [
              {
                type: "text",
                text: `Signed-in Teams user: ${displayName} <${email}>`,
              },
            ],
            details: {
              ok: true,
              displayName,
              email,
              tenantId: auth.tenantId,
              userId: auth.userId,
            },
          };
        },
      }),
      { name: "msteams_whoami", optional: true },
    );
  },
};

/**
 * @param {unknown} openClawConfig
 * @returns {{ ok: true; value: { downstreamBaseUrl: string; audience: string; scope: string; profilePath: string } } | { ok: false; reason: string; missing: string[] }}
 */
function resolveDownstreamProfileConfig(openClawConfig) {
  const config = readPluginConfig(openClawConfig);
  const downstreamBaseUrl = readString(config.downstreamBaseUrl);
  const audience = readString(config.audience);
  const scope = readString(config.scope) || DEFAULT_DOWNSTREAM_SCOPE;
  const profilePath = readString(config.profilePath) || DEFAULT_PROFILE_PATH;

  const missing = [
    downstreamBaseUrl ? undefined : "downstreamBaseUrl",
    audience ? undefined : "audience",
  ].filter((entry) => typeof entry === "string");

  if (missing.length > 0) {
    return {
      ok: false,
      reason: `set plugins.entries.${PLUGIN_ID}.config.${missing.join(" and ")}`,
      missing,
    };
  }
  if (!downstreamBaseUrl || !audience) {
    return {
      ok: false,
      reason: `set plugins.entries.${PLUGIN_ID}.config.downstreamBaseUrl and audience`,
      missing: ["downstreamBaseUrl", "audience"],
    };
  }

  return {
    ok: true,
    value: {
      downstreamBaseUrl,
      audience,
      scope,
      profilePath,
    },
  };
}

/**
 * @param {unknown} openClawConfig
 * @returns {Record<string, unknown>}
 */
function readPluginConfig(openClawConfig) {
  const root = asRecord(openClawConfig);
  const plugins = asRecord(root?.plugins);
  const entries = asRecord(plugins?.entries);
  const entry = asRecord(entries?.[PLUGIN_ID]);
  return asRecord(entry?.config) ?? {};
}

/**
 * @param {{ downstreamBaseUrl: string; profilePath: string }} config
 */
function resolveProfileUrl(config) {
  const base = config.downstreamBaseUrl.endsWith("/")
    ? config.downstreamBaseUrl
    : `${config.downstreamBaseUrl}/`;
  const path = config.profilePath.startsWith("/")
    ? config.profilePath.slice(1)
    : config.profilePath;
  return new URL(path, base).toString();
}

/**
 * @param {unknown} value
 */
function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined;
}
