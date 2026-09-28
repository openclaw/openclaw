import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { ZoomMeetingsConfig, ZoomMeetingsMode } from "./config.js";
import { zoomMeetingsChrome } from "./transports/chrome.js";
import { ZOOM_MEETINGS_PLATFORM_ADAPTER } from "./transports/zoom-meetings-platform-adapter.js";

export const getZoomMeetingsSetupStatus = MeetingPlatformAdapter.createRuntimeSetup<
  ZoomMeetingsConfig,
  ZoomMeetingsMode
>({
  assertAudioDeviceAvailable: zoomMeetingsChrome.assertAudioDeviceAvailable,
  captionsMessage: (mode) =>
    mode === "transcribe"
      ? "Zoom live-caption capture is enabled and ready"
      : "Caption scraping is not used by talk-back modes",
  connectedNodeMessage: (node) => `Connected Zoom meeting node ready: ${node}`,
  guestJoinCheck: (config) => {
    const ok = Boolean(
      config.chrome.guestName &&
      config.chrome.autoJoin &&
      (config.chrome.launch || config.chrome.reuseExistingTab),
    );
    return {
      ok,
      message: ok
        ? "Guest name, auto-join, and a Chrome launch or reuse path are configured"
        : "Set chrome.guestName, chrome.autoJoin, and either chrome.launch or chrome.reuseExistingTab for unattended guest joins",
    };
  },
  missingNodeIdMessage: "Connected Zoom meetings node did not include a node id.",
  nodeAdapter: ZOOM_MEETINGS_PLATFORM_ADAPTER,
});
