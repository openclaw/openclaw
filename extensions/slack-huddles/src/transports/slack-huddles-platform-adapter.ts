import {
  MeetingPlatformAdapter,
  type MeetingBrowserJoinSession,
  type MeetingManualActionCategory,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { SlackHuddlesMode } from "../config.js";
import {
  slackHuddleAudioCaptureScript,
  slackHuddleLeaveScript,
  slackHuddleStatusScript,
  slackHuddleTranscriptScript,
} from "./slack-huddles-page-scripts.js";
import {
  isRecoverableSlackHuddleTab,
  isSameSlackHuddleUrl,
  normalizeSlackHuddleUrl,
  normalizeSlackHuddleUrlForReuse,
} from "./slack-huddles-urls.js";
import type { SlackHuddlesChromeHealth, SlackHuddlesTranscriptSnapshot } from "./types.js";

function slackHuddleOrigin(meetingUrl: string): string | undefined {
  return normalizeSlackHuddleUrlForReuse(meetingUrl) ? "https://app.slack.com" : undefined;
}

const manualActionCategories = new Map<string, MeetingManualActionCategory>([
  ["slack-login-required", "login-required"],
  ["slack-admission-required", "admission-required"],
  ["slack-permission-required", "permission-required"],
  ["slack-audio-choice-required", "audio-choice-required"],
  ["slack-session-conflict", "session-conflict"],
  ["browser-control-unavailable", "browser-control-unavailable"],
]);

export const SLACK_HUDDLES_PLATFORM_ADAPTER = MeetingPlatformAdapter.create<
  MeetingBrowserJoinSession<SlackHuddlesMode>,
  SlackHuddlesMode,
  SlackHuddlesChromeHealth,
  SlackHuddlesTranscriptSnapshot
>({
  id: "slack-huddles",
  displayName: "Slack huddles",
  browserLabel: "Slack huddle",
  logScope: "[slack-huddles]",
  agentConsult: {
    surface: "a private Slack huddle",
    userLabel: "Participant",
    assistantLabel: "Agent",
    questionSourceLabel: "participant",
    workingResponseLabel: "participant",
    extraSystemPrompt: [
      "You are a behind-the-scenes consultant for a live meeting voice agent.",
      "Prioritize a fast, speakable answer over exhaustive investigation.",
      "Use only bounded, task-relevant tool calls.",
      "Never print secrets or dump environment variables.",
      "Be accurate, brief, and speakable.",
    ].join(" "),
  },
  session: {
    idPrefix: "slack_huddle",
    participantIdentity: (transport) =>
      transport === "chrome-node"
        ? "Slack user in Chrome on a paired node"
        : "Slack user in the OpenClaw Chrome profile",
  },
  nodeCommandName: "slackhuddles.chrome",
  nodeConfigPath: "plugins.entries.slack-huddles.config.chromeNode.node",
  urls: {
    validateAndNormalize: normalizeSlackHuddleUrl,
    normalizeForReuse: normalizeSlackHuddleUrlForReuse,
    isSameMeeting: isSameSlackHuddleUrl,
    buildJoinUrl: (session) => session.url,
    accountHint: () => undefined,
    isPreferredJoinUrl: (url) => Boolean(normalizeSlackHuddleUrlForReuse(url)),
    isRecoverableTab: isRecoverableSlackHuddleTab,
    localeAction: () => undefined,
  },
  browser: {
    buildAudioCaptureScript: slackHuddleAudioCaptureScript,
    allowsMicrophone: MeetingPlatformAdapter.isTalkBackMode,
    buildStatusJoinScript: (params) =>
      slackHuddleStatusScript({
        allowMicrophone: MeetingPlatformAdapter.isTalkBackMode(params.mode),
        allowSessionAdoption: params.allowSessionAdoption,
        autoJoin: params.autoJoin,
        captureCaptions: params.captureCaptions,
        guestName: params.guestName,
        meetingSessionId: params.meetingSessionId || undefined,
        meetingUrl: params.url,
        readOnly: params.readOnly,
        waitForInCallMs: params.waitForInCallMs,
      }),
    shouldRetryJoinStatus: (health) =>
      health.inCall === true &&
      health.manualAction?.reason === "slack-audio-choice-required" &&
      health.audioInputRouted === true &&
      health.audioOutputRouteRetryable === true,
    browserControlUnavailable: () => ({
      category: "browser-control-unavailable",
      reason: "browser-control-unavailable",
      message:
        "Open the OpenClaw browser profile, finish Slack sign-in, admission, or permission prompt, then retry.",
    }),
    buildLeaveScript: (meetingUrl) =>
      slackHuddleLeaveScript({
        leaveInitiated: false,
        meetingSessionId: "",
        meetingUrl,
      }),
    buildSessionLeaveScript: slackHuddleLeaveScript,
    captions: {
      // Durable notes observe the caption stream in every mode; live transcript
      // visibility remains gated by MeetingSessionRuntime.
      enabled: () => true,
      buildTranscriptScript: ({ finalize, meetingSessionId, meetingUrl }) =>
        slackHuddleTranscriptScript(meetingUrl, meetingSessionId, finalize),
    },
    permissions: ({ allowMicrophone, meetingUrl }) => {
      const origin = slackHuddleOrigin(meetingUrl);
      return allowMicrophone && origin
        ? {
            origin,
            permissions: ["audioCapture"],
            optionalPermissions: ["speakerSelection"],
          }
        : undefined;
    },
  },
  parsing: {
    classifyManualActionReason: (reason) => manualActionCategories.get(reason) ?? "custom",
    displayName: "Slack huddle",
    invalidTranscriptMessage: "Slack huddle transcript payload is invalid.",
    malformedStatusMessage: "Slack huddle browser status JSON is malformed.",
    malformedTranscriptMessage: "Slack huddle transcript JSON is malformed.",
  },
});
