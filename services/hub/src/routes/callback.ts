import { Hono } from "hono";
import { html } from "hono/html";
import type { Env } from "../env.js";
import { getInstance, upsertConnection, updateInstanceUrls } from "../db/queries.js";
import { waitForContainerRestart, getContainerStartedAt } from "../docker/manager.js";
import { patchGatewayConfig } from "../gateway/config-patch.js";
import { exchangeCode } from "../oauth/slack.js";
import { consumeState } from "../oauth/state.js";

function successPage(teamName: string) {
  return html`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Slack Connected</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8f9fa}
.card{background:#fff;border-radius:12px;padding:2rem 3rem;box-shadow:0 2px 8px rgba(0,0,0,.1);text-align:center;max-width:400px}
h1{color:#2ea44f;margin-bottom:.5rem}p{color:#586069}</style></head>
<body><div class="card"><h1>Connected!</h1><p>Slack workspace <strong>${teamName}</strong> has been connected to OpenClaw.</p>
<p>You can close this window.</p></div></body></html>`;
}

function errorPage(message: string) {
  return html`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Slack OAuth Error</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8f9fa}
.card{background:#fff;border-radius:12px;padding:2rem 3rem;box-shadow:0 2px 8px rgba(0,0,0,.1);text-align:center;max-width:400px}
h1{color:#d73a49;margin-bottom:.5rem}p{color:#586069}</style></head>
<body><div class="card"><h1>Error</h1><p>${message}</p>
<p><a href="/slack/install">Try again</a></p></div></body></html>`;
}

export function createCallbackRoute(env: Env) {
  const callback = new Hono();

  callback.get("/slack/callback", async (c) => {
    const error = c.req.query("error");
    if (error) {
      return c.html(errorPage(`Slack authorization was denied: ${error}`), 400);
    }

    const code = c.req.query("code");
    const state = c.req.query("state");

    if (!code || !state) {
      return c.html(errorPage("Missing code or state parameter."), 400);
    }

    // Validate CSRF state and extract instance_id
    const instanceId = consumeState(state, env.STATE_SECRET);
    if (!instanceId) {
      return c.html(errorPage("Invalid or expired state. Please try the installation again."), 403);
    }

    const instance = getInstance(instanceId);
    if (!instance) {
      return c.html(errorPage("The target OpenClaw instance no longer exists."), 404);
    }

    // Exchange code for token
    let oauthRes;
    try {
      oauthRes = await exchangeCode({
        code,
        clientId: env.SLACK_CLIENT_ID,
        clientSecret: env.SLACK_CLIENT_SECRET,
        redirectUri: env.SLACK_OAUTH_REDIRECT_URI,
      });
    } catch (err) {
      console.error("Slack OAuth exchange failed:", err);
      return c.html(errorPage("Failed to exchange authorization code with Slack."), 502);
    }

    if (!oauthRes.ok || !oauthRes.access_token) {
      console.error("Slack OAuth response error:", oauthRes.error);
      return c.html(errorPage(`Slack OAuth error: ${oauthRes.error ?? "unknown"}`), 502);
    }

    const botToken = oauthRes.access_token;
    if (!botToken.startsWith("xoxb-")) {
      console.error("Unexpected token prefix:", botToken.slice(0, 8));
      return c.html(errorPage("Received unexpected token type from Slack."), 502);
    }

    const teamId = oauthRes.team?.id;
    const teamName = oauthRes.team?.name ?? null;

    if (!teamId) {
      return c.html(errorPage("Slack response missing team ID."), 502);
    }

    // Store connection in DB
    upsertConnection({
      instanceId,
      provider: "slack",
      externalId: teamId,
      externalName: teamName,
      credentials: { botToken, botUserId: oauthRes.bot_user_id ?? null },
    });

    // Patch the OpenClaw instance config via gateway WS
    if (instance.deviceCredentials && instance.containerId) {
      try {
        // Record start time so we can detect the container restart
        const startedAt = await getContainerStartedAt(instance.containerId);

        await patchGatewayConfig({
          gatewayUrl: instance.gatewayUrl,
          gatewayToken: instance.gatewayToken,
          device: instance.deviceCredentials,
          botToken,
          signingSecret: env.SLACK_SIGNING_SECRET,
        });

        // The channels config change causes a full gateway restart which
        // cycles the container.  PublishAllPorts means Docker assigns new
        // random host ports, so we must re-inspect and update the DB.
        try {
          const newUrls = await waitForContainerRestart(instance.containerId, startedAt);
          updateInstanceUrls(instanceId, newUrls.gatewayUrl, newUrls.bridgeUrl);
          console.log(
            `Instance ${instanceId} ports refreshed: gateway=${newUrls.gatewayUrl} bridge=${newUrls.bridgeUrl}`,
          );
        } catch (restartErr) {
          console.warn("Could not detect container restart (ports may be stale):", restartErr);
        }
      } catch (err) {
        console.error("Gateway config patch failed:", err);
        return c.html(
          errorPage("Connected to Slack but failed to update OpenClaw config. Check gateway logs."),
          502,
        );
      }
    } else if (instance.deviceCredentials) {
      try {
        await patchGatewayConfig({
          gatewayUrl: instance.gatewayUrl,
          gatewayToken: instance.gatewayToken,
          device: instance.deviceCredentials,
          botToken,
          signingSecret: env.SLACK_SIGNING_SECRET,
        });
      } catch (err) {
        console.error("Gateway config patch failed:", err);
        return c.html(
          errorPage("Connected to Slack but failed to update OpenClaw config. Check gateway logs."),
          502,
        );
      }
    } else {
      console.warn(`Instance ${instanceId} has no device credentials; skipping config patch.`);
    }

    return c.html(successPage(teamName ?? "your workspace"));
  });

  return callback;
}
