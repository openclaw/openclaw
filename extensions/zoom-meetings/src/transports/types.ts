import type { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";

type ZoomMeetingsConfig = ReturnType<
  ReturnType<typeof MeetingPlatformAdapter.createPluginConfigSchema>["resolveConfig"]
>;
export type ZoomMeetingsMode = ZoomMeetingsConfig["defaultMode"];
type ZoomMeetingsTransport = "chrome" | "chrome-node";

export type ZoomMeetingsManualActionReason =
  | "zoom-login-required"
  | "zoom-admission-required"
  | "zoom-permission-required"
  | "zoom-audio-choice-required"
  | "zoom-camera-required"
  | "zoom-microphone-required"
  | "zoom-passcode-required"
  | "zoom-captcha-required"
  | "zoom-session-conflict"
  | "browser-control-unavailable";

export type ZoomMeetingsSpeechBlockedReason =
  | ZoomMeetingsManualActionReason
  | "not-in-call"
  | "browser-unverified"
  | "audio-bridge-unavailable"
  | "zoom-microphone-muted";

type ZoomMeetingsPluginTypes = ReturnType<
  typeof MeetingPlatformAdapter.pluginTypes<
    ZoomMeetingsConfig,
    ZoomMeetingsTransport,
    ZoomMeetingsMode,
    ZoomMeetingsManualActionReason,
    ZoomMeetingsSpeechBlockedReason,
    { meetingEnded?: boolean }
  >
>;
export type ZoomMeetingsTranscriptSnapshot = ZoomMeetingsPluginTypes["TranscriptSnapshot"];
export type ZoomMeetingsChromeHealth = ZoomMeetingsPluginTypes["ChromeHealth"];
