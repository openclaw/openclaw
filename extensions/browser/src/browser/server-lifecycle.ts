/**
 * Browser server lifecycle helpers for relay setup and profile shutdown.
 */
import { emitNodeGatewayEvent } from "openclaw/plugin-sdk/gateway-runtime";
import { getRuntimeConfig } from "../config/config.js";
import { stopOpenClawChrome } from "./chrome.js";
import type { ResolvedBrowserConfig } from "./config.js";
import { ensureExtensionBridge, stopExtensionBridge } from "./extension-bridge-manager.js";
import {
  type BrowserServerState,
  createBrowserRouteContext,
  listKnownProfileNames,
} from "./server-context.js";

/**
 * System prompt that makes the agent behave as the browser copilot. Injected as
 * extraSystemPrompt on every node-originated side-panel turn so the persona
 * ships with the extension instead of relying on a deployment-side prompt/CLAUDE.md.
 */
const BROWSER_COPILOT_SYSTEM_PROMPT = `You are OpenClaw Browser Copilot, running in the user's web browser via a side panel. You control the user's CURRENT browser tab with your browser tool: navigate, read the page, click, type, fill forms, scroll, and extract.

- The user is looking at a live tab right now and their requests are about THAT page. Read the current tab (URL, title, visible content) for context before acting; do not guess about what is on screen.
- ALWAYS act through the browser tool on the live attached tab. Never fetch a page over HTTP as a substitute, and never say you cannot access the browser or that it is not connected -- the tab IS attached, so use it.
- Be proactive and actually do the web task: navigate, search, click links, fill in fields, extract the answer. Do not refuse ordinary browsing or automation.
- If a step genuinely requires the user (a CAPTCHA, a 2FA code, a payment, or a login only they can complete), do everything up to that point first, then tell them the one thing they need to do.
- Do not re-navigate to a page you are already on; navigating reloads it and can lose scroll position, form input, or login state. Navigate only when a different page is needed.
- Keep replies short: say what you did and what is now on the page.`;

/**
 * Start the node-owned CDP bridge when any profile uses driver "extension".
 * The bundled Chrome extension dials into the bridge and the profile attaches to
 * it as a loopback existing-session, so the agent drives the user's real tab.
 */
export async function ensureExtensionRelayForProfiles(params: {
  resolved: ResolvedBrowserConfig;
  onWarn: (message: string) => void;
}) {
  const profiles = params.resolved.profiles ?? {};
  const needsBridge = Object.values(profiles).some((p) => p?.driver === "extension");
  if (!needsBridge) return;
  try {
    await ensureExtensionBridge({
      onWarn: params.onWarn,
      // Require the extension to present the configured gateway token (as an HMAC)
      // before it can drive the browser or originate turns; undefined on a
      // tokenless loopback gateway, where the bridge stays trusted-local.
      authToken: getRuntimeConfig().gateway?.auth?.token,
      // Originate node-attributed turns when this process is a paired node-host.
      // emitNodeGatewayEvent throws if no node connection is registered (e.g. a
      // gateway-only deployment), which the bridge surfaces to the side panel so
      // it can fall back to a direct gateway turn.
      onAgentRequest: (payload) =>
        emitNodeGatewayEvent("agent.request", {
          ...payload,
          extraSystemPrompt: BROWSER_COPILOT_SYSTEM_PROMPT,
        }),
    });
  } catch (err) {
    params.onWarn(`extension bridge failed to start: ${String(err)}`);
  }
}

/** Stops every known Browser profile during runtime shutdown. */
export async function stopKnownBrowserProfiles(params: {
  getState: () => BrowserServerState | null;
  onWarn: (message: string) => void;
}) {
  await stopExtensionBridge().catch(() => {});
  const current = params.getState();
  if (!current) {
    return;
  }
  const ctx = createBrowserRouteContext({
    getState: params.getState,
    refreshConfigFromDisk: true,
  });
  try {
    for (const name of listKnownProfileNames(current)) {
      try {
        const runtime = current.profiles.get(name);
        if (runtime?.running) {
          await stopOpenClawChrome(runtime.running);
          runtime.running = null;
          continue;
        }
        await ctx.forProfile(name).stopRunningBrowser();
      } catch {
        // ignore
      }
    }
  } catch (err) {
    params.onWarn(`openclaw browser stop failed: ${String(err)}`);
  }
}
