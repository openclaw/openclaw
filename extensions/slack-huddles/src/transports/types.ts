import type { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";

type SlackHuddlesConfig = ReturnType<
  ReturnType<typeof MeetingPlatformAdapter.createPluginConfigSchema>["resolveConfig"]
>;
export type SlackHuddlesMode = SlackHuddlesConfig["defaultMode"];
type SlackHuddlesTransport = "chrome" | "chrome-node";

export type SlackHuddlesManualActionReason =
  | "slack-login-required"
  | "slack-admission-required"
  | "slack-permission-required"
  | "slack-audio-choice-required"
  | "slack-camera-required"
  | "slack-microphone-required"
  | "slack-confirmation-required"
  | "slack-huddle-not-active"
  | "slack-session-conflict"
  | "browser-control-unavailable";

export type SlackHuddlesSpeechBlockedReason =
  | SlackHuddlesManualActionReason
  | "not-in-call"
  | "browser-unverified"
  | "audio-bridge-unavailable"
  | "slack-microphone-muted";

type SlackHuddlesPluginTypes = ReturnType<
  typeof MeetingPlatformAdapter.pluginTypes<
    SlackHuddlesConfig,
    SlackHuddlesTransport,
    SlackHuddlesMode,
    SlackHuddlesManualActionReason,
    SlackHuddlesSpeechBlockedReason
  >
>;
export type SlackHuddlesTranscriptSnapshot = SlackHuddlesPluginTypes["TranscriptSnapshot"];
export type SlackHuddlesChromeHealth = SlackHuddlesPluginTypes["ChromeHealth"];
