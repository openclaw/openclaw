import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  leaveMeetingWithBrowser,
  readMeetingTranscriptWithBrowser,
  recoverMeetingBrowserTab,
  resolveLocalMeetingBrowserRequest,
  MeetingPlatformAdapter,
  type MeetingBrowserRequestCaller,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveTranscriptsConfig } from "openclaw/plugin-sdk/transcripts";
import type { GoogleMeetConfig, GoogleMeetMode } from "../config.js";
import { callBrowserProxyOnNode, resolveChromeNode } from "./chrome-browser-proxy.js";
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

export async function launchChromeMeet(
  params: Parameters<typeof chromeTransport.launchInChrome>[0],
): ReturnType<typeof chromeTransport.launchInChrome> {
  const result = await chromeTransport.launchInChrome(params);
  return { ...result, audioBridge: result.audioBridge };
}

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

function chromeNodeBrowserRequest(
  runtime: PluginRuntime,
  nodeId: string,
): MeetingBrowserRequestCaller {
  return async (request) =>
    await callBrowserProxyOnNode({
      runtime,
      nodeId,
      method: request.method,
      path: request.path,
      body: request.body,
      timeoutMs: request.timeoutMs,
    });
}

export async function leaveChromeMeet(
  params: ChromeBrowserRouteParams & {
    meetingSessionId: string;
    meetingUrl: string;
    tab: GoogleMeetBrowserTab;
  },
): Promise<{ left: boolean; note: string }> {
  // A pinned session node bypasses inventory, including the empty-string value.
  // Keep this await conditional; launch:false leave still resolves the route.
  const node =
    params.transport === "chrome-node"
      ? {
          nodeId:
            params.nodeId ??
            (await resolveChromeNode({
              runtime: params.runtime,
              requestedNode: params.config.chromeNode.node,
            })),
        }
      : undefined;
  return await leaveMeetingWithBrowser({
    adapter: GOOGLE_MEET_PLATFORM_ADAPTER,
    callBrowser: node
      ? chromeNodeBrowserRequest(params.runtime, node.nodeId)
      : await resolveLocalMeetingBrowserRequest(params.runtime),
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
  const node =
    params.transport === "chrome-node"
      ? {
          nodeId:
            params.nodeId ??
            (await resolveChromeNode({
              runtime: params.runtime,
              requestedNode: params.config.chromeNode.node,
            })),
        }
      : undefined;
  return await readMeetingTranscriptWithBrowser({
    adapter: GOOGLE_MEET_PLATFORM_ADAPTER,
    callBrowser: node
      ? chromeNodeBrowserRequest(params.runtime, node.nodeId)
      : await resolveLocalMeetingBrowserRequest(params.runtime),
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
  const node =
    params.transport === "chrome-node"
      ? {
          nodeId: await resolveChromeNode({
            runtime: params.runtime,
            requestedNode: params.config.chromeNode.node,
          }),
        }
      : undefined;
  return {
    ...(node
      ? { transport: "chrome-node" as const, nodeId: node.nodeId }
      : { transport: "chrome" as const }),
    ...(await recoverMeetingBrowserTab({
      adapter: GOOGLE_MEET_PLATFORM_ADAPTER,
      callBrowser: node
        ? chromeNodeBrowserRequest(params.runtime, node.nodeId)
        : await resolveLocalMeetingBrowserRequest(params.runtime),
      captureCaptions: shouldCaptureCaptions(params.mode ?? "bidi", params.fullConfig),
      config: params.config.chrome,
      locationLabel: node ? "on the selected Chrome node" : "in local Chrome",
      mode: params.mode ?? "bidi",
      readOnly: params.readOnly,
      requestedMeetingUrl: params.url,
      trackedMeetingUrl: params.trackedMeetingUrl,
      trackedTargetId: params.trackedTargetId,
    })),
  };
}
