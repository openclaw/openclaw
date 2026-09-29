import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { SlackHuddlesConfig } from "./config.js";
import { SLACK_HUDDLES_PLATFORM_ADAPTER } from "./transports/slack-huddles-platform-adapter.js";

export function createSlackHuddlesNodeInvokePolicy(config: SlackHuddlesConfig) {
  return MeetingPlatformAdapter.createPluginNodeInvokePolicy(config, {
    deniedCode: "SLACK_HUDDLES_NODE_POLICY_DENIED",
    platform: SLACK_HUDDLES_PLATFORM_ADAPTER,
  });
}
