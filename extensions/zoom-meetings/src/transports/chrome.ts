import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { ZOOM_MEETINGS_PLATFORM_ADAPTER } from "./zoom-meetings-platform-adapter.js";

export const zoomMeetingsChrome = MeetingPlatformAdapter.createPluginChromeTransport({
  meetingLabel: "Zoom meeting",
  platform: ZOOM_MEETINGS_PLATFORM_ADAPTER,
  preserveTrackedBrowserOnEngineFailure: true,
  runtime: MeetingPlatformAdapter.createChromeRuntimeBindings(),
});
