import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { SlackHuddlesConfig, SlackHuddlesMode, SlackHuddlesTransport } from "./config.js";
import { slackHuddlesInvalidRequest } from "./errors.js";
import type {
  SlackHuddlesChromeHealth,
  SlackHuddlesJoinRequest,
  SlackHuddlesSession,
} from "./transports/types.js";

export const slackHuddlesProbes = MeetingPlatformAdapter.createRuntimeProbes<
  SlackHuddlesConfig,
  SlackHuddlesMode,
  SlackHuddlesTransport,
  SlackHuddlesChromeHealth,
  SlackHuddlesSession,
  SlackHuddlesJoinRequest
>({
  defaultSpeechMessage: "Say exactly: Slack huddle speech test complete.",
  invalidRequest: slackHuddlesInvalidRequest,
  resolveTimeoutMs: (input, fallback) =>
    MeetingPlatformAdapter.resolveProbeTimeoutMs(input, fallback, slackHuddlesInvalidRequest),
  shouldWaitForListening: (session) => Boolean(session.chrome?.browserTab?.targetId),
  talkBackMode: MeetingPlatformAdapter.isTalkBackMode,
});
