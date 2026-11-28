import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { GoogleMeetConfig, GoogleMeetMode } from "../config.js";
import { GOOGLE_MEET_PLATFORM_ADAPTER } from "./google-meet-platform-adapter.js";
import {
  GOOGLE_MEET_BROWSER_NODE_ADAPTER,
  GOOGLE_MEET_NODE_COMMAND,
} from "./google-meet-platform-constants.js";
import type {
  GoogleMeetBrowserTab,
  GoogleMeetChromeHealth,
  GoogleMeetTranscriptSnapshot,
} from "./types.js";

const chromeTransport = MeetingPlatformAdapter.createChromeTransportWithExternalAudio<
  GoogleMeetConfig,
  GoogleMeetMode,
  GoogleMeetChromeHealth,
  GoogleMeetTranscriptSnapshot
>({
  browserNodeAdapter: GOOGLE_MEET_BROWSER_NODE_ADAPTER,
  isRealtimeRouteReady: (mode, health) =>
    !MeetingPlatformAdapter.isTalkBackMode(mode) ||
    MeetingPlatformAdapter.isRealtimeRouteReady(mode, health),
  isTalkBackMode: MeetingPlatformAdapter.isTalkBackMode,
  meetingLabel: "Google Meet",
  nodeCommandName: GOOGLE_MEET_NODE_COMMAND,
  platform: GOOGLE_MEET_PLATFORM_ADAPTER,
  preserveTrackedBrowserOnEngineFailure: false,
  startupFailurePolicy: "owned",
  runtime: MeetingPlatformAdapter.createChromeRuntimeBindings(),
});

export const assertGoogleMeetAudioAvailable = chromeTransport.assertAudioDeviceAvailable;
export const launchChromeMeetOnNode = chromeTransport.launchOnNode;

export const launchChromeMeet = chromeTransport.launchInChrome;

type ChromeBrowserRouteParams = {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  transport?: "chrome" | "chrome-node";
  nodeId?: string;
};

type SessionTab = {
  meetingSessionId: string;
  meetingUrl: string;
  tab: GoogleMeetBrowserTab;
};

export function leaveChromeMeet(params: ChromeBrowserRouteParams & SessionTab) {
  return chromeTransport.leaveInBrowser({
    ...params,
    transport: params.transport ?? "chrome",
    // Meet requires browser launch permission even for a reused tab.
    requireLaunch: true,
  });
}

export function readChromeMeetTranscript(
  params: ChromeBrowserRouteParams & SessionTab & { finalize?: boolean },
) {
  return chromeTransport.readTranscript({ ...params, transport: params.transport ?? "chrome" });
}

export function recoverCurrentMeetTab(
  params: Omit<ChromeBrowserRouteParams, "nodeId"> & {
    fullConfig?: OpenClawConfig;
    mode?: GoogleMeetMode;
    readOnly?: boolean;
    trackedMeetingUrl?: string;
    trackedTargetId?: string;
    url?: string;
  },
) {
  // Recovery follows the current configured node; leave and captions follow the session pin.
  return chromeTransport.recoverCurrentTab({
    runtime: params.runtime,
    config: params.config,
    fullConfig: params.fullConfig,
    transport: params.transport ?? "chrome",
    mode: params.mode ?? "bidi",
    readOnly: params.readOnly,
    trackedMeetingUrl: params.trackedMeetingUrl,
    trackedTargetId: params.trackedTargetId,
    url: params.url,
  });
}
