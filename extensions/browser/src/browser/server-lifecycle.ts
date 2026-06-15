/**
 * Browser server lifecycle helpers for relay setup and profile shutdown.
 */
import { emitNodeGatewayEvent } from "openclaw/plugin-sdk/gateway-runtime";
import { stopOpenClawChrome } from "./chrome.js";
import type { ResolvedBrowserConfig } from "./config.js";
import { ensureExtensionBridge, stopExtensionBridge } from "./extension-bridge-manager.js";
import {
  type BrowserServerState,
  createBrowserRouteContext,
  listKnownProfileNames,
} from "./server-context.js";

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
      // Originate node-attributed turns when this process is a paired node-host.
      // emitNodeGatewayEvent throws if no node connection is registered (e.g. a
      // gateway-only deployment), which the bridge surfaces to the side panel so
      // it can fall back to a direct gateway turn.
      onAgentRequest: (payload) => emitNodeGatewayEvent("agent.request", payload),
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
