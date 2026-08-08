import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { recordNonAuthoritativeMeetingBrowserRecoveryFailureForProbe } from "openclaw/plugin-sdk/meeting-runtime-probes";
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

function isRecoveryDeadlinePast(deadline: number | undefined): boolean {
  return deadline !== undefined && Date.now() > deadline;
}

export async function refreshGoogleMeetBrowserHealth(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  logger: RuntimeLogger;
  options?: { force?: boolean; readOnly?: boolean; timeoutMs?: number; deadline?: number };
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
            deadline: options.deadline,
            timeoutMs: options.timeoutMs,
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
            deadline: options.deadline,
            timeoutMs: options.timeoutMs,
            trackedMeetingUrl: session.url,
            trackedTargetId: session.chrome?.browserTab?.targetId,
            url: session.url,
          });
    if (session.state !== "active" || isRecoveryDeadlinePast(options.deadline)) {
      return false;
    }
    if (result.found && session.chrome) {
      session.browserLeft = undefined;
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
          recordNonAuthoritativeMeetingBrowserRecoveryFailureForProbe(session, {
            kind: "error",
            message: result.message,
          });
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
      recordNonAuthoritativeMeetingBrowserRecoveryFailureForProbe(session, {
        kind: "missing",
        message: result.message,
      });
    }
    return false;
  } catch (error) {
    if (session.state !== "active" || isRecoveryDeadlinePast(options.deadline)) {
      return false;
    }
    const message = `Google Meet browser readiness refresh failed: ${formatErrorMessage(error)}`;
    logger.debug?.(`[google-meet] ${message}`);
    if (options.force && session.chrome) {
      recordNonAuthoritativeMeetingBrowserRecoveryFailureForProbe(session, {
        kind: "error",
        message,
      });
    }
    return false;
  }
}
