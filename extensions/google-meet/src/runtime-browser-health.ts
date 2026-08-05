import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type { GoogleMeetConfig } from "./config.js";
import { recoverCurrentMeetTab, recoverCurrentMeetTabOnNode } from "./transports/chrome.js";
import type { GoogleMeetChromeHealth, GoogleMeetSession } from "./transports/types.js";

function clearNonAuthoritativeManualAction(
  health: GoogleMeetChromeHealth | undefined,
): GoogleMeetChromeHealth | undefined {
  if (!health || health.manualAction === undefined) {
    return health;
  }
  const { manualAction: _manualAction, ...rest } = health;
  return rest;
}

export async function refreshGoogleMeetBrowserHealth(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  logger: RuntimeLogger;
  options?: { force?: boolean; readOnly?: boolean };
  runtime: PluginRuntime;
  session: GoogleMeetSession;
}): Promise<boolean> {
  const { config, fullConfig, logger, options = {}, runtime, session } = params;
  try {
    const result =
      session.transport === "chrome-node"
        ? await recoverCurrentMeetTabOnNode({
            runtime,
            config,
            fullConfig,
            mode: session.mode,
            readOnly: options.readOnly,
            trackedMeetingUrl: session.url,
            trackedTargetId: session.chrome?.browserTab?.targetId,
            url: session.url,
          })
        : await recoverCurrentMeetTab({
            runtime,
            config,
            fullConfig,
            mode: session.mode,
            readOnly: options.readOnly,
            trackedMeetingUrl: session.url,
            trackedTargetId: session.chrome?.browserTab?.targetId,
            url: session.url,
          });
    if (result.found && session.chrome) {
      if (result.targetId) {
        const currentTab = session.chrome.browserTab;
        session.chrome.browserTab = {
          targetId: result.targetId,
          openedByPlugin:
            result.targetId === currentTab?.targetId ? currentTab.openedByPlugin : false,
        };
      }
      if (!result.browser) {
        if (options.force) {
          session.chrome.health = clearNonAuthoritativeManualAction(session.chrome.health);
        }
        return false;
      }
      const refreshedHealth = { ...session.chrome.health, ...result.browser };
      session.chrome.health = Object.hasOwn(result.browser, "manualAction")
        ? refreshedHealth
        : clearNonAuthoritativeManualAction(refreshedHealth);
      session.updatedAt = new Date().toISOString();
      return true;
    }
    if (options.force && session.chrome) {
      session.chrome.health = clearNonAuthoritativeManualAction(session.chrome.health);
    }
    return false;
  } catch (error) {
    logger.debug?.(`[google-meet] browser readiness refresh ignored: ${formatErrorMessage(error)}`);
    if (options.force && session.chrome) {
      session.chrome.health = clearNonAuthoritativeManualAction(session.chrome.health);
    }
    return false;
  }
}
