import type {
  MeetingParticipationEffectResult,
  MeetingParticipationRequest,
  MeetingParticipationSource,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { GoogleMeetConfig } from "./config.js";
import { participateInChromeMeet, readChromeMeetChat } from "./transports/chrome.js";
import {
  GOOGLE_MEET_CHAT_PARTICIPATION_ADAPTER,
  meetChatParticipationSources,
} from "./transports/google-meet-chat-scripts.js";
import type { GoogleMeetBrowserTab, GoogleMeetSession } from "./transports/types.js";

type ChatRuntimeParams = {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
};

function isBrowserTransport(transport: GoogleMeetSession["transport"]): boolean {
  return transport === "chrome" || transport === "chrome-node";
}

function chromeRoute(session: GoogleMeetSession) {
  return session.transport === "chrome-node"
    ? { transport: "chrome-node" as const, nodeId: session.chrome?.nodeId }
    : {};
}

export function meetChatCapabilities(session: GoogleMeetSession): readonly string[] {
  return isBrowserTransport(session.transport) && session.chrome?.browserTab
    ? GOOGLE_MEET_CHAT_PARTICIPATION_ADAPTER.capabilities
    : [];
}

export const validateMeetChatParticipationAction =
  GOOGLE_MEET_CHAT_PARTICIPATION_ADAPTER.validateAction;

export async function executeMeetChatParticipation(
  params: ChatRuntimeParams & {
    session: GoogleMeetSession;
    request: MeetingParticipationRequest;
    assertCurrent: () => void;
  },
): Promise<MeetingParticipationEffectResult> {
  const { session, request } = params;
  const tab = session.chrome?.browserTab;
  if (!isBrowserTransport(session.transport) || !tab) {
    return {
      status: "unsupported",
      message: "Participation requires a supported tracked browser meeting.",
    };
  }
  return await participateInChromeMeet({
    runtime: params.runtime,
    ...chromeRoute(session),
    config: params.config,
    action: request.action,
    assertCurrent: params.assertCurrent,
    meetingSessionId: session.id,
    meetingUrl: session.url,
    requestId: request.requestId,
    tab,
  });
}

/**
 * Reads the in-call chat for an active browser session and returns the
 * participation sources to observe. A different tab is a different chat log,
 * so the epoch retires stale chat sources when the tracked tab changes.
 */
export async function observeMeetChat(
  params: ChatRuntimeParams & { session: GoogleMeetSession; tab: GoogleMeetBrowserTab },
): Promise<MeetingParticipationSource[]> {
  const { session, tab } = params;
  if (session.state !== "active") {
    return [];
  }
  const messages = await readChromeMeetChat({
    runtime: params.runtime,
    ...chromeRoute(session),
    config: params.config,
    meetingUrl: session.url,
    tab,
  });
  if (!messages) {
    return [];
  }
  return meetChatParticipationSources(messages, {
    meetingSessionId: session.id,
    epoch: `${session.id}:${tab.targetId}`,
  });
}
