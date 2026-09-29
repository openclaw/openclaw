import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { SlackHuddlesConfig, SlackHuddlesMode, SlackHuddlesTransport } from "./config.js";
import { slackHuddlesProbes } from "./runtime-probes.js";
import { getSlackHuddlesSetupStatus } from "./runtime-setup.js";
import { slackHuddlesChrome } from "./transports/chrome.js";
import { SLACK_HUDDLES_PLATFORM_ADAPTER } from "./transports/slack-huddles-platform-adapter.js";
import type { SlackHuddlesChromeHealth } from "./transports/types.js";

export const SlackHuddlesRuntime = MeetingPlatformAdapter.createRuntimeFacade<
  SlackHuddlesConfig,
  SlackHuddlesTransport,
  SlackHuddlesMode,
  SlackHuddlesChromeHealth,
  {
    setup: Awaited<ReturnType<typeof getSlackHuddlesSetupStatus>>;
    listening: Awaited<ReturnType<typeof slackHuddlesProbes.testListening>>;
    speech: Awaited<ReturnType<typeof slackHuddlesProbes.testSpeech>>;
  }
>({
  platform: SLACK_HUDDLES_PLATFORM_ADAPTER,
  transport: slackHuddlesChrome,
  probes: {
    setupStatus: getSlackHuddlesSetupStatus,
    ...slackHuddlesProbes,
  },
  hooks: {
    isAwaitingAdmission: (session) =>
      session.chrome?.health?.manualAction?.reason === "slack-admission-required",
  },
  messages: {
    durableTranscripts: { providerId: "slack-huddle", providerName: "Slack huddle" },
    joined: {
      local:
        "Slack user joined in local Chrome with realtime audio through the native virtual-audio backend.",
      node: "Slack user joined in Chrome on the selected node with realtime audio through the node bridge.",
      transcribe: "Slack user joined observe-only with live-caption transcript capture.",
      waiting:
        "Slack user join is waiting for the browser to become ready before starting realtime audio.",
    },
    leaveFailed: (error) => `Browser control could not leave the Slack huddle tab: ${error}`,
    noTrackedTab:
      "No tracked Slack huddle tab; leave the browser meeting manually if it is still active.",
    sharedTab: "Kept the shared Slack huddle tab open for another active session.",
    sessionRuntime: {
      previousBrowserLeaveFailed:
        "Could not leave the previous Slack huddle tab before reassignment.",
      reassignedSessionNote:
        "Ended before the same Slack huddle tab was reassigned to another agent.",
      reusedSessionNote: "Reused existing active Slack meeting session.",
      replacementBrowserLeaveFailed:
        "Could not leave the previous Slack huddle tab before reassignment.",
      speechBlockedFallback: "Realtime speech blocked until Slack is ready.",
      speech: {
        audioBridgeUnavailable: "Realtime speech requires an active Chrome audio bridge.",
        browserUnverified: "Slack browser state has not been verified yet.",
        microphoneMuted: "Turn on the OpenClaw Slack microphone before asking OpenClaw to speak.",
        microphoneMutedReason: "slack-microphone-muted",
        notInCall: "Slack has not reported that the Slack user is in the huddle.",
        notInCallReason: "not-in-call",
        browserUnverifiedReason: "browser-unverified",
        audioBridgeUnavailableReason: "audio-bridge-unavailable",
      },
    },
  },
});
