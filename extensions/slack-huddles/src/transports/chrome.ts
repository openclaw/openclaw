import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { SLACK_HUDDLES_PLATFORM_ADAPTER } from "./slack-huddles-platform-adapter.js";

export const slackHuddlesChrome = MeetingPlatformAdapter.createPluginChromeTransport({
  meetingLabel: "Slack huddle",
  platform: SLACK_HUDDLES_PLATFORM_ADAPTER,
  preserveTrackedBrowserOnEngineFailure: true,
  runtime: MeetingPlatformAdapter.createChromeRuntimeBindings(),
});
