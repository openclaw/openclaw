import type { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";

type TeamsMeetingsConfig = ReturnType<
  ReturnType<typeof MeetingPlatformAdapter.createPluginConfigSchema>["resolveConfig"]
>;
export type TeamsMeetingsMode = TeamsMeetingsConfig["defaultMode"];
type TeamsMeetingsTransport = "chrome" | "chrome-node";

export type TeamsMeetingsManualActionReason =
  | "teams-login-required"
  | "teams-admission-required"
  | "teams-permission-required"
  | "teams-audio-choice-required"
  | "teams-camera-required"
  | "teams-microphone-required"
  | "teams-session-conflict"
  | "browser-control-unavailable";

export type TeamsMeetingsSpeechBlockedReason =
  | TeamsMeetingsManualActionReason
  | "not-in-call"
  | "browser-unverified"
  | "audio-bridge-unavailable"
  | "teams-microphone-muted";

type TeamsMeetingsPluginTypes = ReturnType<
  typeof MeetingPlatformAdapter.pluginTypes<
    TeamsMeetingsConfig,
    TeamsMeetingsTransport,
    TeamsMeetingsMode,
    TeamsMeetingsManualActionReason,
    TeamsMeetingsSpeechBlockedReason
  >
>;
export type TeamsMeetingsTranscriptSnapshot = TeamsMeetingsPluginTypes["TranscriptSnapshot"];
export type TeamsMeetingsChromeHealth = TeamsMeetingsPluginTypes["ChromeHealth"];
