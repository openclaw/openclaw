import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { addTimerTimeoutGraceMs } from "openclaw/plugin-sdk/number-runtime";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "openclaw/plugin-sdk/realtime-voice";
import { ZOOM_MEETINGS_CLI_METADATA } from "./cli-metadata.js";
import { ZoomMeetingsInvalidRequestError } from "./src/errors.js";
import type {
  ZoomMeetingsManualActionReason,
  ZoomMeetingsSpeechBlockedReason,
} from "./src/transports/types.js";
import { ZOOM_MEETINGS_PLATFORM_ADAPTER } from "./src/transports/zoom-meetings-platform-adapter.js";
import { hasSameZoomMeetingJoinCredential } from "./src/transports/zoom-meetings-urls.js";

export const zoomMeetingsPlugin = MeetingPlatformAdapter.defineBrowserMeetingPlugin<
  ZoomMeetingsManualActionReason,
  ZoomMeetingsSpeechBlockedReason
>({
  platform: ZOOM_MEETINGS_PLATFORM_ADAPTER,
  labels: {
    meeting: "Zoom meeting",
    participant: "Zoom guest",
    brand: "Zoom",
    microphone: "Zoom",
    browserPage: "Zoom",
  },
  config: {
    defaultRealtimeInstructions: `You are joining a private Zoom meeting as an OpenClaw voice transport. Keep spoken replies brief and natural. In agent mode, wait for OpenClaw consult results and speak them exactly. In bidi mode, answer directly and call ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} for deeper reasoning, current information, or tools.`,
    resolveGatewayOperationTimeoutMs: (config) =>
      Math.max(
        60_000,
        addTimerTimeoutGraceMs(
          config.chrome.joinTimeoutMs,
          config.chrome.waitForInCallMs + config.chrome.joinTimeoutMs + 30_000,
        ) ?? 1,
      ),
  },
  InvalidRequestError: ZoomMeetingsInvalidRequestError,
  toolUrlDescription: "Zoom meeting URL",
  transcriptSource: { id: "zoom", aliases: ["zoom-meetings"], providerName: "Zoom" },
  hooks: {
    // Normalize before locking so credential reuse sees the exact launched request.
    normalizeJoinRequest: (request, context) => {
      const resolved = context.resolvedJoin(request);
      return { ...request, agentId: resolved.agentId, url: resolved.url };
    },
    // Stateful admission refresh lets the admitted page adopt its existing session.
    isAwaitingAdmission: (session) =>
      session.chrome?.health?.lobbyWaiting === true ||
      session.chrome?.health?.manualAction?.reason === "zoom-admission-required",
    // Only Zoom treats a missing or host-ended page as terminal during status.
    afterStatusRefresh: async (session, context) => {
      const confirmedTabMissing = session.chrome?.health?.status === "browser-tab-missing";
      if (session.state === "active" && confirmedTabMissing) {
        session.browserLeft = true;
        await context.endSession(session.id, { keepBrowserTab: true });
      } else if (session.state === "active" && session.chrome?.health?.meetingEnded === true) {
        await context.endSession(session.id);
      }
    },
    // Corrected passcodes replace pending joins; safe stale sessions retain their tab.
    refreshReusableSession: async (session, request, context) => {
      await context.refreshBrowserHealth(session, { force: true, readOnly: false });
      const browser = session.chrome;
      const health = browser?.health;
      const staleSession =
        !browser?.browserTab ||
        health?.meetingEnded === true ||
        health?.manualAction?.reason === "zoom-session-conflict" ||
        health?.manualAction?.reason === "browser-control-unavailable" ||
        health?.bridgeClosed === true;
      const replacePendingJoin =
        health?.inCall !== true &&
        health?.manualAction?.reason === "zoom-passcode-required" &&
        !hasSameZoomMeetingJoinCredential(session.url, request.url);
      if (!staleSession && !replacePendingJoin) {
        return undefined;
      }
      session.state = "ended";
      session.updatedAt = new Date().toISOString();
      context.noteSession(
        session,
        replacePendingJoin
          ? "Ended pending Zoom session after receiving a corrected meeting credential."
          : "Ended stale Zoom session before opening a replacement.",
      );
      context.deleteRequesterSessionKey(session.id);
      return {
        keepBrowserTab:
          !replacePendingJoin && health?.meetingEnded !== true && health?.bridgeClosed !== true,
      };
    },
    // A closed Zoom realtime engine is absent so a later speak can rebuild it.
    isAudioBridgeActive: (session) =>
      Boolean(session.chrome?.audioBridge && session.chrome.health?.bridgeClosed !== true),
    afterAudioBridgeAttached: (session) => {
      if (session.chrome) {
        session.chrome.health = { ...session.chrome.health, bridgeClosed: false };
      }
    },
    validateLaunchResult: (result) => {
      if (result.browser?.meetingEnded === true) {
        throw new Error("The Zoom meeting has already ended.");
      }
    },
    // Missing or unreachable browser state is authoritative for Zoom session reuse;
    // recording it prevents a dead tab from being reported or reused as active.
    recordBrowserRecoveryFailure: (session, failure) => {
      if (!session.chrome) {
        return;
      }
      if (failure.kind === "missing") {
        session.chrome.browserTab = undefined;
        session.browserLeft = true;
      }
      session.chrome.health = {
        ...session.chrome.health,
        inCall: false,
        micMuted: undefined,
        captioning: false,
        audioInputRouted: false,
        audioOutputRouted: false,
        manualAction: { reason: "browser-control-unavailable", message: failure.message },
        status: failure.kind === "missing" ? "browser-tab-missing" : "browser-control",
        notes: [
          ...(session.chrome.health?.notes ?? []).filter((note) => note !== failure.message),
          failure.message,
        ],
      };
      session.updatedAt = new Date().toISOString();
    },
  },
  browserReadinessFailed: (error) => `Zoom browser readiness refresh failed: ${error}`,
  microphoneMutedReason: "zoom-microphone-muted",
  setup: {
    captionsMessage: (mode) =>
      mode === "transcribe"
        ? "Zoom live-caption capture is enabled and ready"
        : "Caption scraping is not used by talk-back modes",
    connectedNodeMessage: (node) => `Connected Zoom meeting node ready: ${node}`,
    guestJoinCheck: (config) => {
      const ok = Boolean(
        config.chrome.guestName &&
        config.chrome.autoJoin &&
        (config.chrome.launch || config.chrome.reuseExistingTab),
      );
      return {
        ok,
        message: ok
          ? "Guest name, auto-join, and a Chrome launch or reuse path are configured"
          : "Set chrome.guestName, chrome.autoJoin, and either chrome.launch or chrome.reuseExistingTab for unattended guest joins",
      };
    },
    missingNodeIdMessage: "Connected Zoom meetings node did not include a node id.",
  },
  defaultSpeechMessage: "Say exactly: Zoom speech test complete.",
  shouldWaitForListening: (session) => Boolean(session.chrome?.browserTab?.targetId),
  sharePrerequisiteDeadline: true,
  preserveTrackedBrowserOnEngineFailure: true,
  nodePolicyDeniedCode: "ZOOM_MEETINGS_NODE_POLICY_DENIED",
  cli: {
    descriptor: ZOOM_MEETINGS_CLI_METADATA.descriptor,
    joinDescription: "join a Zoom meeting as a guest",
  },
});

export default zoomMeetingsPlugin.plugin;
