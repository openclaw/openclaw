import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { SlackHuddlesConfig, SlackHuddlesMode } from "./config.js";
import { slackHuddlesChrome } from "./transports/chrome.js";
import { SLACK_HUDDLES_PLATFORM_ADAPTER } from "./transports/slack-huddles-platform-adapter.js";

export const getSlackHuddlesSetupStatus = MeetingPlatformAdapter.createRuntimeSetup<
  SlackHuddlesConfig,
  SlackHuddlesMode
>({
  assertAudioDeviceAvailable: slackHuddlesChrome.assertAudioDeviceAvailable,
  captionsMessage: () =>
    "Slack captions depend on the account preference to turn on captions by default when joining huddles",
  connectedNodeMessage: (node) => `Connected Slack huddles node ready: ${node}`,
  guestJoinCheck: (config) => {
    const ok = config.chrome.autoJoin && (config.chrome.launch || config.chrome.reuseExistingTab);
    return {
      ok,
      message: ok
        ? "Auto-join and Chrome launch or reuse are configured; sign this profile into the dedicated Slack user account"
        : "Set chrome.autoJoin and either chrome.launch or chrome.reuseExistingTab, then sign the Chrome profile into Slack",
    };
  },
  missingNodeIdMessage: "Connected Slack huddles node did not include a node id.",
  nodeAdapter: SLACK_HUDDLES_PLATFORM_ADAPTER,
});
