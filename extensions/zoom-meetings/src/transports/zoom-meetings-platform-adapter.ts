import {
  MeetingPlatformAdapter,
  type MeetingBrowserJoinSession,
} from "openclaw/plugin-sdk/meeting-runtime";
import type {
  ZoomMeetingsChromeHealth,
  ZoomMeetingsMode,
  ZoomMeetingsTranscriptSnapshot,
} from "./types.js";
import { zoomMeetingPageScripts } from "./zoom-meetings-page-scripts.js";
import {
  isRecoverableZoomMeetingTab,
  isSameZoomMeetingUrl,
  normalizeZoomMeetingUrl,
  normalizeZoomMeetingUrlForReuse,
} from "./zoom-meetings-urls.js";

function zoomMeetingOrigin(meetingUrl: string): string | undefined {
  return normalizeZoomMeetingUrlForReuse(meetingUrl) ? "https://app.zoom.us" : undefined;
}

export const ZOOM_MEETINGS_PLATFORM_ADAPTER = MeetingPlatformAdapter.create<
  MeetingBrowserJoinSession<ZoomMeetingsMode>,
  ZoomMeetingsMode,
  ZoomMeetingsChromeHealth,
  ZoomMeetingsTranscriptSnapshot
>({
  id: "zoom-meetings",
  displayName: "Zoom meetings",
  browserLabel: "Zoom meeting",
  logScope: "[zoom-meetings]",
  agentConsult: {
    surface: "a private Zoom meeting",
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
    idPrefix: "zoom_meeting",
    participantIdentity: (transport) =>
      transport === "chrome-node"
        ? "Zoom guest in Chrome on a paired node"
        : "Zoom guest in the OpenClaw Chrome profile",
  },
  nodeCommandName: "zoommeetings.chrome",
  nodeConfigPath: "plugins.entries.zoom-meetings.config.chromeNode.node",
  urls: {
    validateAndNormalize: normalizeZoomMeetingUrl,
    normalizeForReuse: normalizeZoomMeetingUrlForReuse,
    isSameMeeting: isSameZoomMeetingUrl,
    buildJoinUrl: (session) => session.url,
    accountHint: () => undefined,
    isPreferredJoinUrl: (url) => Boolean(normalizeZoomMeetingUrlForReuse(url)),
    isRecoverableTab: isRecoverableZoomMeetingTab,
    localeAction: () => undefined,
  },
  ...MeetingPlatformAdapter.createBrowserAdapterOptions<
    ZoomMeetingsMode,
    ZoomMeetingsChromeHealth,
    ZoomMeetingsTranscriptSnapshot
  >({
    displayName: "Zoom",
    manualActionReasonPrefix: "zoom",
    admissionReasons: ["zoom-passcode-required", "zoom-captcha-required"],
    retryCaptions: true,
    unavailableMessage:
      "Open the OpenClaw browser profile, finish the Zoom sign-in, admission, or permission prompt, then retry.",
    origin: zoomMeetingOrigin,
    scripts: zoomMeetingPageScripts,
    statusFields: (parsed) => ({
      meetingEnded: typeof parsed.meetingEnded === "boolean" ? parsed.meetingEnded : undefined,
    }),
  }),
});
