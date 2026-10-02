import {
  MeetingPlatformAdapter,
  type MeetingBrowserJoinSession,
} from "openclaw/plugin-sdk/meeting-runtime";
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
import type {
  SlackHuddlesChromeHealth,
  SlackHuddlesMode,
  SlackHuddlesTranscriptSnapshot,
} from "./types.js";

function slackHuddleOrigin(meetingUrl: string): string | undefined {
  return normalizeSlackHuddleUrlForReuse(meetingUrl) ? "https://app.slack.com" : undefined;
}

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
  ...MeetingPlatformAdapter.createBrowserAdapterOptions({
    displayName: "Slack huddle",
    manualActionReasonPrefix: "slack",
    retryCaptions: false,
    unavailableMessage:
      "Open the OpenClaw browser profile, finish Slack sign-in, admission, or permission prompt, then retry.",
    origin: slackHuddleOrigin,
    scripts: {
      audioCapture: slackHuddleAudioCaptureScript,
      status: slackHuddleStatusScript,
      leave: slackHuddleLeaveScript,
      transcript: slackHuddleTranscriptScript,
    },
  }),
});
