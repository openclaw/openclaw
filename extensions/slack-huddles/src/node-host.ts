import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { slackHuddlesConfig } from "./config.js";
import { SLACK_HUDDLES_PLATFORM_ADAPTER } from "./transports/slack-huddles-platform-adapter.js";

export const handleSlackHuddlesNodeHostCommand = MeetingPlatformAdapter.createPluginNodeHostHandler(
  {
    platform: SLACK_HUDDLES_PLATFORM_ADAPTER,
    browserPageName: "Slack huddle",
    meetingLabel: "Slack huddle",
    defaultAudioInputCommand: slackHuddlesConfig.defaultAudioInputCommand,
    defaultAudioOutputCommand: slackHuddlesConfig.defaultAudioOutputCommand,
    sharePrerequisiteDeadline: true,
  },
);
