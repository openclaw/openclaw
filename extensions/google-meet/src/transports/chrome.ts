import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  callMeetingBrowserProxyOnNode,
  leaveMeetingWithBrowser,
  readMeetingTranscriptWithBrowser,
  recoverMeetingBrowserTab,
  resolveLocalMeetingBrowserRequest,
  resolveMeetingBrowserNode,
  MeetingPlatformAdapter,
  type MeetingBrowserRequestCaller,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveTranscriptsConfig } from "openclaw/plugin-sdk/transcripts";
import type { GoogleMeetConfig, GoogleMeetMode } from "../config.js";
import { GOOGLE_MEET_PLATFORM_ADAPTER } from "./google-meet-platform-adapter.js";
import {
  GOOGLE_MEET_BROWSER_NODE_ADAPTER,
  GOOGLE_MEET_NODE_COMMAND,
} from "./google-meet-platform-constants.js";
import type {
  GoogleMeetBrowserTab,
  GoogleMeetChromeHealth,
  GoogleMeetSession,
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

function shouldCaptureCaptions(mode: GoogleMeetMode, fullConfig?: OpenClawConfig): boolean {
  return (
    mode === "transcribe" || !fullConfig || resolveTranscriptsConfig(fullConfig.transcripts).enabled
  );
}

type ChromeBrowserRouteParams = {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  transport?: "chrome" | "chrome-node";
  nodeId?: string;
};

type ChromeBrowserRoute = {
  callBrowser: MeetingBrowserRequestCaller;
} & ({ transport: "chrome"; nodeId?: undefined } | { transport: "chrome-node"; nodeId: string });

async function resolveChromeBrowserRoute(
  params: ChromeBrowserRouteParams,
): Promise<ChromeBrowserRoute> {
  if (params.transport !== "chrome-node") {
    return {
      transport: "chrome",
      callBrowser: await resolveLocalMeetingBrowserRequest(params.runtime),
    };
  }
  const nodeId =
    params.nodeId ??
    (await resolveMeetingBrowserNode({
      runtime: params.runtime,
      requestedNode: params.config.chromeNode.node,
      adapter: GOOGLE_MEET_BROWSER_NODE_ADAPTER,
    }));
  return {
    transport: "chrome-node",
    nodeId,
    callBrowser: (request) =>
      callMeetingBrowserProxyOnNode({
        ...request,
        runtime: params.runtime,
        nodeId,
        adapter: GOOGLE_MEET_BROWSER_NODE_ADAPTER,
      }),
  };
}

export async function leaveChromeMeet(
  params: ChromeBrowserRouteParams & {
    meetingSessionId: string;
    meetingUrl: string;
    tab: GoogleMeetBrowserTab;
  },
): Promise<{ left: boolean; note: string }> {
  const { callBrowser } = await resolveChromeBrowserRoute(params);
  return leaveMeetingWithBrowser({
    adapter: GOOGLE_MEET_PLATFORM_ADAPTER,
    callBrowser,
    launch: params.config.chrome.launch,
    meetingSessionId: params.meetingSessionId,
    meetingUrl: params.meetingUrl,
    tab: params.tab,
    timeoutMs: params.config.chrome.joinTimeoutMs,
  });
}

export async function readChromeMeetTranscript(
  params: ChromeBrowserRouteParams & {
    finalize?: boolean;
    meetingUrl: string;
    meetingSessionId: string;
    tab: GoogleMeetBrowserTab;
  },
): Promise<GoogleMeetTranscriptSnapshot> {
  const { callBrowser } = await resolveChromeBrowserRoute(params);
  return readMeetingTranscriptWithBrowser({
    adapter: GOOGLE_MEET_PLATFORM_ADAPTER,
    callBrowser,
    finalize: params.finalize === true,
    meetingUrl: params.meetingUrl,
    meetingSessionId: params.meetingSessionId,
    tab: params.tab,
    timeoutMs: Math.min(Math.max(1_000, params.config.chrome.joinTimeoutMs), 10_000),
  });
}

export async function recoverCurrentMeetTab(
  params: Omit<ChromeBrowserRouteParams, "nodeId"> & {
    fullConfig?: OpenClawConfig;
    mode?: GoogleMeetMode;
    readOnly?: boolean;
    trackedMeetingUrl?: string;
    trackedTargetId?: string;
    url?: string;
  },
): Promise<
  Awaited<
    ReturnType<
      typeof recoverMeetingBrowserTab<
        GoogleMeetSession,
        GoogleMeetMode,
        GoogleMeetChromeHealth,
        GoogleMeetTranscriptSnapshot
      >
    >
  > &
    ({ transport: "chrome"; nodeId?: undefined } | { transport: "chrome-node"; nodeId: string })
> {
  // Recovery deliberately re-resolves the configured node, not the session pin.
  const { callBrowser, ...route } = await resolveChromeBrowserRoute({
    ...params,
    nodeId: undefined,
  });
  return {
    ...route,
    ...(await recoverMeetingBrowserTab({
      adapter: GOOGLE_MEET_PLATFORM_ADAPTER,
      callBrowser,
      captureCaptions: shouldCaptureCaptions(params.mode ?? "bidi", params.fullConfig),
      config: params.config.chrome,
      locationLabel:
        route.transport === "chrome-node" ? "on the selected Chrome node" : "in local Chrome",
      mode: params.mode ?? "bidi",
      readOnly: params.readOnly,
      requestedMeetingUrl: params.url,
      trackedMeetingUrl: params.trackedMeetingUrl,
      trackedTargetId: params.trackedTargetId,
    })),
  };
}
