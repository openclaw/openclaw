import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { TokenStore, exchangeCode, buildAuthUrl, generateOAuthState } from "./src/oauth.js";
import { createStravaTools } from "./src/tools.js";
import type { StravaConfig } from "./src/types.js";

const OAUTH_CALLBACK_PATH = "/api/plugins/strava/oauth/callback";
const OAUTH_START_PATH = "/api/plugins/strava/oauth/start";
const DEFAULT_GATEWAY_PORT = 18789;

const stravaPlugin = {
  id: "strava",
  name: "Strava",
  description:
    "Connect your Strava account to let the AI agent read your running activities and act as a coach.",
  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const clientId = pluginConfig.clientId as string | undefined;
    const clientSecret = pluginConfig.clientSecret as string | undefined;

    if (!clientId || !clientSecret) {
      api.logger.warn(
        "strava: plugin not activated — set plugins.entries.strava.config.clientId and plugins.entries.strava.config.clientSecret in your config. " +
          "Create a Strava API app at https://www.strava.com/settings/api",
      );
      return;
    }

    const config: StravaConfig = { clientId, clientSecret };
    const gatewayPort = (api.config.gateway?.port as number | undefined) ?? DEFAULT_GATEWAY_PORT;
    const callbackUrl = pluginConfig.callbackUrl as string | undefined;

    // Use a strava subdirectory under the main state dir for token storage.
    const stateDir = path.join(api.runtime.state.resolveStateDir(), "strava");
    const tokenStore = new TokenStore(stateDir);

    const getRedirectUri = () => {
      // Explicit override takes priority (tunnels, custom domains).
      if (callbackUrl) return callbackUrl;
      const gwTls = (api.config.gateway as Record<string, unknown> | undefined)?.tls as
        | Record<string, unknown>
        | undefined;
      const tls = !!gwTls?.enabled;
      const scheme = tls ? "https" : "http";
      // Derive from gateway bind config when not loopback.
      const bind = api.config.gateway?.bind as string | undefined;
      const customHost = api.config.gateway?.customBindHost as string | undefined;
      if (bind === "custom" && customHost?.trim()) {
        return `${scheme}://${customHost.trim()}:${gatewayPort}${OAUTH_CALLBACK_PATH}`;
      }
      // Default to localhost for loopback / unset bind.
      return `${scheme}://localhost:${gatewayPort}${OAUTH_CALLBACK_PATH}`;
    };

    // Register the 4 Strava tools.
    const tools = createStravaTools({ config, tokenStore, getRedirectUri });
    for (const tool of tools) {
      api.registerTool(tool as AnyAgentTool, { optional: true });
    }

    // OAuth callback — receives the redirect from Strava after user authorizes.
    api.registerHttpRoute({
      path: OAUTH_CALLBACK_PATH,
      auth: "plugin",
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const error = url.searchParams.get("error");

          // Validate OAuth state nonce to prevent CSRF.
          if (!state || !tokenStore.consumeState(state)) {
            res.statusCode = 403;
            res.setHeader("Content-Type", "text/html");
            res.end(
              htmlPage(
                "Invalid State",
                "OAuth state mismatch — this request may not have originated from your gateway. Please try connecting again.",
              ),
            );
            return;
          }

          if (error) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "text/html");
            res.end(
              htmlPage(
                "Authorization Denied",
                "You denied the Strava authorization request. You can close this tab.",
              ),
            );
            return;
          }

          if (!code) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "text/html");
            res.end(htmlPage("Missing Code", "No authorization code received from Strava."));
            return;
          }

          // Strava returns the granted scopes — reject if the user declined activity access.
          const grantedScope = url.searchParams.get("scope") ?? "";
          if (!grantedScope.includes("activity:read")) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "text/html");
            res.end(
              htmlPage(
                "Insufficient Permissions",
                "The activity read permission is required. Please try connecting again and grant activity access.",
              ),
            );
            return;
          }

          const tokens = await exchangeCode(config, code);
          tokenStore.save(tokens);

          api.logger.info(`strava: connected athlete ${tokens.athleteId}`);

          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html");
          res.end(
            htmlPage(
              "Strava Connected!",
              "Your Strava account is now linked. You can close this tab and ask your AI assistant about your runs.",
            ),
          );
        } catch (err) {
          api.logger.error(`strava: OAuth callback error: ${err}`);
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/html");
          res.end(
            htmlPage(
              "Connection Failed",
              "Something went wrong connecting to Strava. Check the gateway logs.",
            ),
          );
        }
      },
    });

    // Convenience redirect — visiting this URL starts the OAuth flow.
    // Uses "gateway" auth so only authenticated users can initiate token binding.
    api.registerHttpRoute({
      path: OAUTH_START_PATH,
      auth: "gateway",
      handler: async (_req: IncomingMessage, res: ServerResponse) => {
        const state = generateOAuthState();
        tokenStore.saveState(state);
        const authUrl = buildAuthUrl(clientId, getRedirectUri(), state);
        res.statusCode = 302;
        res.setHeader("Location", authUrl);
        res.end();
      },
    });

    api.logger.info("strava: plugin activated");
  },
};

function htmlPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}
.card{background:#fff;border-radius:12px;padding:2rem;max-width:400px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.1)}
h1{font-size:1.5rem;margin:0 0 1rem}</style>
</head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

export default stravaPlugin;
