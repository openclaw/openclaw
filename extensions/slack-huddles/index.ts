import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { addTimerTimeoutGraceMs } from "openclaw/plugin-sdk/number-runtime";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "openclaw/plugin-sdk/realtime-voice";
import { SLACK_HUDDLES_CLI_METADATA } from "./cli-metadata.js";
import { SlackHuddlesInvalidRequestError } from "./src/errors.js";
import { SLACK_HUDDLES_PLATFORM_ADAPTER } from "./src/transports/slack-huddles-platform-adapter.js";
import type {
  SlackHuddlesManualActionReason,
  SlackHuddlesSpeechBlockedReason,
} from "./src/transports/types.js";

export const slackHuddlesPlugin = MeetingPlatformAdapter.defineBrowserMeetingPlugin<
  SlackHuddlesManualActionReason,
  SlackHuddlesSpeechBlockedReason
>({
  platform: SLACK_HUDDLES_PLATFORM_ADAPTER,
  labels: {
    meeting: "Slack huddle",
    participant: "Slack user",
    brand: "Slack",
    microphone: "Slack",
    browserPage: "Slack huddle",
  },
  config: {
    defaultRealtimeInstructions: `You are joining a private Slack huddle as an OpenClaw voice transport. Keep spoken replies brief and natural. In agent mode, wait for OpenClaw consult results and speak them exactly. In bidi mode, answer directly and call ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} for deeper reasoning, current information, or tools.`,
    resolveGatewayOperationTimeoutMs: (config) =>
      Math.max(
        60_000,
        addTimerTimeoutGraceMs(
          config.chrome.joinTimeoutMs,
          config.chrome.waitForInCallMs + config.chrome.joinTimeoutMs + 30_000,
        ) ?? 1,
      ),
  },
  InvalidRequestError: SlackHuddlesInvalidRequestError,
  toolUrlDescription:
    "Slack huddle link (Copy huddle link), or an uppercase Slack channel id such as C0123ABCD / channel:C0123ABCD for the huddle in that channel. Workspace-qualified team:T0123ABCD:channel:C0123ABCD (also with a slack: prefix) gives a team-qualified huddle link. In Slack conversations the Conversation info chat_id carries the channel reference.",
  transcriptSource: {
    id: "slack-huddle",
    aliases: ["slack-huddles"],
    providerName: "Slack huddle",
  },
  hooks: {
    isAwaitingAdmission: (session) =>
      session.chrome?.health?.manualAction?.reason === "slack-admission-required",
  },
  notInCallMessage: "Slack has not reported that the Slack user is in the huddle.",
  microphoneMutedReason: "slack-microphone-muted",
  setup: {
    captionsMessage: () =>
      "Slack captions depend on the account preference to turn on captions by default when joining huddles",
    connectedNodeMessage: (node) => `Connected Slack huddles node ready: ${node}`,
    guestJoinCheck: (config) => {
      const ok = config.chrome.autoJoin && (config.chrome.launch || config.chrome.reuseExistingTab);
      return {
        ok,
        message: ok
          ? "Auto-join and Chrome launch or reuse are configured; sign this profile into the dedicated Slack user account"
          : "Set chrome.autoJoin and either chrome.launch or chrome.reuseExistingTab, then sign the Chrome profile into Slack",
      };
    },
    missingNodeIdMessage: "Connected Slack huddles node did not include a node id.",
  },
  defaultSpeechMessage: "Say exactly: Slack huddle speech test complete.",
  shouldWaitForListening: (session) => Boolean(session.chrome?.browserTab?.targetId),
  sharePrerequisiteDeadline: true,
  preserveTrackedBrowserOnEngineFailure: true,
  nodePolicyDeniedCode: "SLACK_HUDDLES_NODE_POLICY_DENIED",
  cli: {
    descriptor: SLACK_HUDDLES_CLI_METADATA.descriptor,
    joinDescription: "join a Slack huddle as the claw’s Slack user",
  },
});

export default slackHuddlesPlugin.plugin;
