import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { addTimerTimeoutGraceMs } from "openclaw/plugin-sdk/number-runtime";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "openclaw/plugin-sdk/realtime-voice";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { TEAMS_MEETINGS_CLI_METADATA } from "./cli-metadata.js";
import { TeamsMeetingsInvalidRequestError } from "./src/errors.js";
import { TEAMS_MEETINGS_PLATFORM_ADAPTER } from "./src/transports/teams-meetings-platform-adapter.js";
import type {
  TeamsMeetingsManualActionReason,
  TeamsMeetingsSpeechBlockedReason,
} from "./src/transports/types.js";

export const teamsMeetingsPlugin = MeetingPlatformAdapter.defineBrowserMeetingPlugin<
  TeamsMeetingsManualActionReason,
  TeamsMeetingsSpeechBlockedReason
>({
  platform: TEAMS_MEETINGS_PLATFORM_ADAPTER,
  labels: {
    meeting: "Microsoft Teams meeting",
    participant: "Teams guest",
    brand: "Microsoft Teams",
    microphone: "Teams",
    browserPage: "Teams",
    tab: "Teams meeting",
  },
  config: {
    defaultRealtimeInstructions: `You are joining a private Microsoft Teams meeting as an OpenClaw voice transport. Keep spoken replies brief and natural. In agent mode, wait for OpenClaw consult results and speak them exactly. In bidi mode, answer directly and call ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} for deeper reasoning, current information, or tools.`,
    resolveGatewayOperationTimeoutMs: (config) =>
      Math.max(60_000, addTimerTimeoutGraceMs(config.chrome.joinTimeoutMs, 30_000) ?? 1),
  },
  InvalidRequestError: TeamsMeetingsInvalidRequestError,
  toolUrlDescription: "Microsoft Teams meeting URL",
  transcriptSource: {
    id: "teams",
    aliases: ["teams-meetings", "microsoft-teams", "msteams"],
    providerName: "Microsoft Teams",
  },
  microphoneMutedReason: "teams-microphone-muted",
  setup: {
    captionsMessage: (mode) =>
      mode === "transcribe"
        ? "Teams live-caption capture is enabled and ready"
        : "Caption scraping is not used by talk-back modes",
    connectedNodeMessage: (node) => `Connected Teams meeting node ready: ${node}`,
    guestJoinCheck: (config) => {
      const ok = Boolean(
        config.chrome.guestName && config.chrome.autoJoin && config.chrome.reuseExistingTab,
      );
      return {
        ok,
        message: ok
          ? "Guest name, auto-join, and tab reuse are configured"
          : "Set chrome.guestName, chrome.autoJoin, and chrome.reuseExistingTab for unattended guest joins",
      };
    },
    missingNodeIdMessage: "Connected Microsoft Teams meetings node did not include a node id.",
  },
  defaultSpeechMessage: "Say exactly: Microsoft Teams speech test complete.",
  shouldWaitForListening: ({ chrome }) => Boolean(chrome?.launched || chrome?.browserTab?.targetId),
  sharePrerequisiteDeadline: true,
  preserveTrackedBrowserOnEngineFailure: false,
  nodePolicyDeniedCode: "TEAMS_MEETINGS_NODE_POLICY_DENIED",
  cli: {
    descriptor: TEAMS_MEETINGS_CLI_METADATA.descriptor,
    joinDescription: "join a Teams meeting as a guest",
    resolveTimeoutMs: (operationTimeoutMs, { requestedTimeoutMs }) =>
      Math.max(
        operationTimeoutMs,
        requestedTimeoutMs === undefined
          ? 0
          : (addTimerTimeoutGraceMs(requestedTimeoutMs, 30_000) ?? 1),
      ),
  },
  entry: {
    normalizeRequesterSessionKey: normalizeOptionalString,
    normalizeToolAgentId: (agentId) => (agentId ? normalizeAgentId(agentId) : undefined),
    resolveToolRuntime: async (api, agentId) => {
      const trustedRouting = Boolean(agentId && agentId !== "main");
      const useRuntime = trustedRouting ? await api.runtime.gateway.isAvailable() : false;
      if (trustedRouting && !useRuntime) {
        throw new Error(
          "Per-agent Microsoft Teams meeting routing requires a Gateway-hosted agent run.",
        );
      }
      return useRuntime ? api.runtime : undefined;
    },
    registerNodeWhen: () => true,
  },
});

export default teamsMeetingsPlugin.plugin;
