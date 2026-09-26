import {
  resolveLocalMeetingBrowserRequest,
  runMeetingParticipationWithBrowser,
  type MeetingParticipationRequest,
  type MeetingBrowserRequestCaller,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { GoogleMeetConfig } from "../config.js";
import { callBrowserProxyOnNode } from "./chrome-browser-proxy.js";
import { GOOGLE_MEET_PLATFORM_ADAPTER } from "./google-meet-platform-adapter.js";
import type { GoogleMeetSession } from "./types.js";

export async function participateInChromeMeet(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  session: GoogleMeetSession;
  request: MeetingParticipationRequest;
  assertCurrent(): void;
}) {
  const adapter = GOOGLE_MEET_PLATFORM_ADAPTER.browser.participation;
  const { session } = params;
  const tab = session.chrome?.browserTab;
  if (!adapter || !tab || (session.transport !== "chrome" && session.transport !== "chrome-node")) {
    return {
      status: "unsupported" as const,
      message: "Participation requires a supported tracked browser meeting.",
    };
  }
  const { nodeId } = session.chrome ?? {};
  const meetingSessionId = session.id;
  const meetingUrl = session.url;
  const targetId = tab.targetId;
  // Never discover another node or tab while executing an action for an existing session.
  if (session.transport === "chrome-node" && nodeId === undefined) {
    return { status: "rejected" as const, message: "The meeting has no pinned browser node." };
  }
  params.assertCurrent();
  const callBrowser =
    session.transport === "chrome-node"
      ? (request: Parameters<MeetingBrowserRequestCaller>[0]) =>
          callBrowserProxyOnNode({ ...request, runtime: params.runtime, nodeId: nodeId! })
      : await resolveLocalMeetingBrowserRequest(params.runtime);
  params.assertCurrent();
  return await runMeetingParticipationWithBrowser({
    adapter,
    callBrowser,
    meetingSessionId,
    meetingUrl,
    targetId,
    requestId: params.request.requestId,
    action: params.request.action,
    assertCurrent: () => params.assertCurrent(),
    isSameMeetingUrl: (left, right) => GOOGLE_MEET_PLATFORM_ADAPTER.urls.isSameMeeting(left, right),
    timeoutMs: Math.min(10_000, params.config.chrome.joinTimeoutMs),
  });
}
