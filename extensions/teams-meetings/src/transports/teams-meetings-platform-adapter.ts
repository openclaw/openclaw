import {
  MeetingPlatformAdapter,
  type MeetingBrowserJoinSession,
} from "openclaw/plugin-sdk/meeting-runtime";
import {
  teamsMeetingAudioCaptureScript,
  teamsMeetingLeaveScript,
  teamsMeetingStatusScript,
  teamsMeetingTranscriptScript,
} from "./teams-meetings-page-scripts.js";
import {
  isRecoverableTeamsMeetingTab,
  isSameTeamsMeetingUrl,
  normalizeTeamsMeetingUrl,
  normalizeTeamsMeetingUrlForReuse,
} from "./teams-meetings-urls.js";
import type {
  TeamsMeetingsChromeHealth,
  TeamsMeetingsMode,
  TeamsMeetingsTranscriptSnapshot,
} from "./types.js";

function teamsMeetingOrigin(meetingUrl: string): string | undefined {
  try {
    const origin = new URL(meetingUrl).origin;
    return origin === "https://teams.microsoft.com" || origin === "https://teams.live.com"
      ? origin
      : undefined;
  } catch {
    return undefined;
  }
}

export const TEAMS_MEETINGS_PLATFORM_ADAPTER = MeetingPlatformAdapter.create<
  MeetingBrowserJoinSession<TeamsMeetingsMode>,
  TeamsMeetingsMode,
  TeamsMeetingsChromeHealth,
  TeamsMeetingsTranscriptSnapshot
>({
  id: "teams-meetings",
  displayName: "Microsoft Teams meetings",
  browserLabel: "Teams meeting",
  logScope: "[teams-meetings]",
  agentConsult: {
    surface: "a private Microsoft Teams meeting",
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
    idPrefix: "teams_meeting",
    participantIdentity: (transport) =>
      transport === "chrome-node"
        ? "Microsoft Teams guest in Chrome on a paired node"
        : "Microsoft Teams guest in the OpenClaw Chrome profile",
  },
  nodeCommandName: "teamsmeetings.chrome",
  nodeConfigPath: "plugins.entries.teams-meetings.config.chromeNode.node",
  urls: {
    validateAndNormalize: normalizeTeamsMeetingUrl,
    normalizeForReuse: normalizeTeamsMeetingUrlForReuse,
    isSameMeeting: isSameTeamsMeetingUrl,
    buildJoinUrl: (session) => session.url,
    accountHint: () => undefined,
    isPreferredJoinUrl: (url) => Boolean(normalizeTeamsMeetingUrlForReuse(url)),
    isRecoverableTab: isRecoverableTeamsMeetingTab,
    localeAction: () => undefined,
  },
  ...MeetingPlatformAdapter.createBrowserAdapterOptions({
    displayName: "Teams",
    transcriptDisplayName: "Microsoft Teams",
    manualActionReasonPrefix: "teams",
    retryCaptions: true,
    unavailableMessage:
      "Open the OpenClaw browser profile, finish the Teams sign-in, admission, or permission prompt, then retry.",
    origin: teamsMeetingOrigin,
    scripts: {
      audioCapture: teamsMeetingAudioCaptureScript,
      status: teamsMeetingStatusScript,
      leave: teamsMeetingLeaveScript,
      transcript: teamsMeetingTranscriptScript,
    },
  }),
});
