import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { TEAMS_MEETINGS_PLATFORM_ADAPTER } from "./teams-meetings-platform-adapter.js";

export const teamsMeetingsChrome = MeetingPlatformAdapter.createPluginChromeTransport({
  meetingLabel: "Microsoft Teams meeting",
  platform: TEAMS_MEETINGS_PLATFORM_ADAPTER,
  preserveTrackedBrowserOnEngineFailure: false,
  runtime: MeetingPlatformAdapter.createChromeRuntimeBindings(),
});
