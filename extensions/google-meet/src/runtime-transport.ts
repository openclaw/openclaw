// Stateless transport operations consume the Google Meet runtime's existing owners.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  endMeetingVoiceCallGatewayCall,
  getMeetingVoiceCallGatewayCall,
  isMeetingVoiceCallMissingError,
  MeetingPlatformAdapter,
  speakMeetingViaVoiceCallGateway,
  type MeetingSessionRuntime,
  type MeetingSessionRuntimeHandles,
  type MeetingSessionRuntimeJoinContext,
  type MeetingVoiceCallGateway,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GoogleMeetConfig, GoogleMeetMode, GoogleMeetTransport } from "./config.js";
import { isBrowserTransport, noteSession, withSessionAgentConfig } from "./runtime-session.js";
import {
  launchChromeMeet,
  launchChromeMeetOnNode,
  leaveChromeMeet,
  readChromeMeetTranscript,
  recoverCurrentMeetTab,
} from "./transports/chrome.js";
import { GOOGLE_MEET_PLATFORM_ADAPTER } from "./transports/google-meet-platform-adapter.js";
import type {
  GoogleMeetBrowserTab,
  GoogleMeetChromeHealth,
  GoogleMeetJoinRequest,
  GoogleMeetSession,
} from "./transports/types.js";
import { joinMeetViaVoiceCallGateway } from "./voice-call-gateway.js";

type ChromeAudioBridgeResult = NonNullable<
  | Awaited<ReturnType<typeof launchChromeMeet>>["audioBridge"]
  | Awaited<ReturnType<typeof launchChromeMeetOnNode>>["audioBridge"]
>;
type ChromeLaunchResult =
  | Awaited<ReturnType<typeof launchChromeMeet>>
  | Awaited<ReturnType<typeof launchChromeMeetOnNode>>;
type GoogleMeetManualActionReason = NonNullable<GoogleMeetChromeHealth["manualAction"]>["reason"];
export type GoogleMeetSpeechBlockedReason = NonNullable<
  GoogleMeetChromeHealth["speechBlockedReason"]
>;
export type GoogleMeetSessionRuntime = MeetingSessionRuntime<
  GoogleMeetSession,
  GoogleMeetJoinRequest,
  GoogleMeetTransport,
  GoogleMeetMode,
  GoogleMeetChromeHealth,
  GoogleMeetBrowserTab,
  GoogleMeetManualActionReason,
  GoogleMeetSpeechBlockedReason
>;
type GoogleMeetJoinContext = MeetingSessionRuntimeJoinContext<
  GoogleMeetSession,
  GoogleMeetTransport,
  GoogleMeetMode,
  GoogleMeetChromeHealth,
  GoogleMeetBrowserTab
>;

const nowIso = () => new Date().toISOString();

export type GoogleMeetRuntimeParams = {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
};

export type GoogleMeetRuntimeTransportContext = {
  params: GoogleMeetRuntimeParams;
  sessions: Pick<GoogleMeetSessionRuntime, "list" | "refreshSpeechReadiness" | "markSessionEnded">;
  voiceCallGateway: MeetingVoiceCallGateway;
  createdBrowserTabs: Map<string, string>;
};

export async function joinTransport(
  { params, sessions, voiceCallGateway, createdBrowserTabs }: GoogleMeetRuntimeTransportContext,
  request: GoogleMeetJoinRequest,
  session: GoogleMeetSession,
  context: GoogleMeetJoinContext,
): Promise<{ delegatedSpoken?: boolean }> {
  if (isBrowserTransport(session.transport)) {
    const chromeConfig = withSessionAgentConfig(params.config, session.agentId);
    const launch = session.transport === "chrome-node" ? launchChromeMeetOnNode : launchChromeMeet;
    const result: ChromeLaunchResult = await launch({
      runtime: params.runtime,
      config: chromeConfig,
      fullConfig: params.fullConfig,
      meetingSessionId: session.id,
      requesterSessionKey: request.requesterSessionKey,
      mode: session.mode,
      url: session.url,
      logger: params.logger,
    });
    const nodeId = "nodeId" in result ? result.nodeId : undefined;
    let tab = result.tab;
    const createdKey =
      session.transport === "chrome-node" && nodeId && tab
        ? `${nodeId}:${tab.targetId}`
        : undefined;
    const createdUrl = createdKey ? createdBrowserTabs.get(createdKey) : undefined;
    if (createdKey) {
      createdBrowserTabs.delete(createdKey);
    }
    if (tab && GOOGLE_MEET_PLATFORM_ADAPTER.urls.isSameMeeting(createdUrl, session.url)) {
      tab = { ...tab, openedByPlugin: true };
    }
    tab = context.inheritedBrowserTab({
      session,
      transport: session.transport,
      nodeId,
      meetingUrl: session.url,
      tab,
    });
    session.chrome = {
      audioBackend: result.audioBackend,
      launched: result.launched,
      nodeId,
      browserProfile: params.config.chrome.browserProfile,
      browserTab: tab,
      health: result.browser,
    };
    const handles = attachChromeAudioBridge(session, result.audioBridge);
    if (handles) {
      context.attachRuntimeHandles(session, handles);
    }
    session.notes.push(
      result.audioBridge
        ? session.transport === "chrome-node"
          ? "Chrome node transport joins as the signed-in Google profile on the selected node and routes realtime audio through the node bridge."
          : "Chrome transport joins as the signed-in Google profile and routes realtime audio through the configured bridge."
        : MeetingPlatformAdapter.isTalkBackMode(session.mode)
          ? "Chrome transport is waiting for verified virtual input/output audio routing."
          : "Chrome transport joins as the signed-in Google profile without starting the realtime audio bridge.",
    );
    sessions.refreshSpeechReadiness(session);
    return {};
  }

  const dialPlan = GOOGLE_MEET_PLATFORM_ADAPTER.dialIn!.buildPlan({
    dialInNumber: request.dialInNumber,
    defaultDialInNumber: params.config.twilio.defaultDialInNumber,
    pin: request.pin,
    defaultPin: params.config.twilio.defaultPin,
    dtmfSequence: request.dtmfSequence,
    defaultDtmfSequence: params.config.twilio.defaultDtmfSequence,
    dtmfDelayMs: params.config.voiceCall.dtmfDelayMs,
  });
  const dialInNumber = dialPlan.number;
  if (!dialInNumber) {
    throw new Error(
      "Twilio transport requires a Meet dial-in phone number. Google Meet URLs do not include dial-in details; pass dialInNumber with optional pin/dtmfSequence, configure twilio.defaultDialInNumber, or use chrome/chrome-node transport.",
    );
  }
  const dtmfSequence = dialPlan.dtmfSequence;
  const hasExplicitAgent = Boolean(
    normalizeOptionalString(request.agentId) ||
    normalizeOptionalString(params.config.realtime.agentId),
  );
  const delegatedAgentId = hasExplicitAgent ? session.agentId : undefined;
  const voiceCallResult = params.config.voiceCall.enabled
    ? await joinMeetViaVoiceCallGateway({
        config: params.config,
        gateway: voiceCallGateway,
        dialInNumber,
        dtmfSequence,
        logger: params.logger,
        ...(request.requesterSessionKey
          ? { requesterSessionKey: request.requesterSessionKey }
          : {}),
        agentId: delegatedAgentId,
        sessionKey: delegatedAgentId
          ? `agent:${delegatedAgentId}:google-meet:${session.id}`
          : `voice:google-meet:${session.id}`,
        message: MeetingPlatformAdapter.isTalkBackMode(session.mode)
          ? (request.message ??
            params.config.voiceCall.introMessage ??
            params.config.realtime.introMessage)
          : undefined,
      })
    : undefined;
  session.twilio = {
    dialInNumber,
    pinProvided: Boolean(dialPlan.pin),
    dtmfSequence,
    voiceCallId: voiceCallResult?.callId,
    dtmfSent: voiceCallResult?.dtmfSent,
    introSent: voiceCallResult?.introSent,
  };
  if (voiceCallResult?.callId) {
    context.attachRuntimeHandles(session, {
      stop: async () => {
        await endMeetingVoiceCallGatewayCall({
          gateway: voiceCallGateway,
          callId: voiceCallResult.callId,
        });
      },
    });
  }
  session.notes.push(
    params.config.voiceCall.enabled
      ? dtmfSequence
        ? "Twilio transport delegated the phone leg to the voice-call plugin, then queued configured DTMF before realtime connect."
        : "Twilio transport delegated the call to the voice-call plugin without configured DTMF."
      : "Twilio transport is an explicit dial plan; voice-call delegation is disabled.",
  );
  return { delegatedSpoken: Boolean(voiceCallResult?.introSent) };
}

function attachChromeAudioBridge(
  session: GoogleMeetSession,
  audioBridge: ChromeAudioBridgeResult | undefined,
): MeetingSessionRuntimeHandles<GoogleMeetChromeHealth> | undefined {
  if (!session.chrome || !audioBridge) {
    return undefined;
  }
  session.chrome.audioBridge = {
    type: audioBridge.type,
    provider:
      audioBridge.type === "command-pair" || audioBridge.type === "node-command-pair"
        ? audioBridge.providerId
        : undefined,
  };
  return audioBridge.type === "command-pair" || audioBridge.type === "node-command-pair"
    ? { stop: audioBridge.stop, speak: audioBridge.speak, getHealth: audioBridge.getHealth }
    : undefined;
}

export async function ensureChromeRealtimeBridge(
  { params }: GoogleMeetRuntimeTransportContext,
  session: GoogleMeetSession,
): Promise<MeetingSessionRuntimeHandles<GoogleMeetChromeHealth> | undefined> {
  if (
    !MeetingPlatformAdapter.isTalkBackMode(session.mode) ||
    !isBrowserTransport(session.transport) ||
    session.state !== "active" ||
    !session.chrome ||
    session.chrome.audioBridge ||
    !MeetingPlatformAdapter.isRealtimeRouteReady(session.mode, session.chrome.health)
  ) {
    return undefined;
  }
  const config = withSessionAgentConfig(params.config, session.agentId);
  // This session already owns its browser tab. Bridge recovery must not
  // launch or navigate another tab, even when tab reuse is disabled.
  const recoveryConfig = {
    ...config,
    chrome: { ...config.chrome, launch: false },
    ...(session.chrome.nodeId
      ? { chromeNode: { ...config.chromeNode, node: session.chrome.nodeId } }
      : {}),
  };
  const launch = session.transport === "chrome-node" ? launchChromeMeetOnNode : launchChromeMeet;
  const result: ChromeLaunchResult = await launch({
    runtime: params.runtime,
    config: recoveryConfig,
    fullConfig: params.fullConfig,
    meetingSessionId: session.id,
    mode: session.mode,
    url: session.url,
    logger: params.logger,
  });
  session.updatedAt = nowIso();
  return attachChromeAudioBridge(session, result.audioBridge);
}

export async function refreshBrowserHealth(
  { params }: GoogleMeetRuntimeTransportContext,
  session: GoogleMeetSession,
  options: { force?: boolean; readOnly?: boolean } = {},
): Promise<void> {
  let verifiedHealth: GoogleMeetChromeHealth | undefined;
  try {
    const result = await recoverCurrentMeetTab({
      runtime: params.runtime,
      config:
        session.transport === "chrome-node" && session.chrome?.nodeId
          ? {
              ...params.config,
              chromeNode: { ...params.config.chromeNode, node: session.chrome.nodeId },
            }
          : params.config,
      fullConfig: params.fullConfig,
      transport: session.transport === "chrome-node" ? "chrome-node" : "chrome",
      mode: session.mode,
      readOnly: options.readOnly,
      trackedMeetingUrl: session.url,
      trackedTargetId: session.chrome?.browserTab?.targetId,
      url: session.url,
    });
    if (options.readOnly) {
      // Verification cannot adopt a different route or borrow its readiness.
      if (
        result.found &&
        result.targetId &&
        result.targetId === session.chrome?.browserTab?.targetId &&
        result.transport === session.transport &&
        (session.transport !== "chrome-node" || result.nodeId === session.chrome?.nodeId)
      ) {
        verifiedHealth = result.browser;
      }
    } else if (result.found && session.chrome) {
      if (result.targetId) {
        const currentTab = session.chrome.browserTab;
        session.chrome.browserTab = {
          targetId: result.targetId,
          openedByPlugin:
            result.targetId === currentTab?.targetId ? currentTab.openedByPlugin : false,
        };
      }
      if (result.browser) {
        session.chrome.health = { ...session.chrome.health, ...result.browser };
      }
      session.updatedAt = nowIso();
    }
  } catch (error) {
    params.logger.debug?.(
      `[google-meet] browser readiness refresh ignored: ${formatErrorMessage(error)}`,
    );
  }
  if (options.readOnly && session.chrome) {
    // Settle fresh facts only after the read. Missing controls, tabs, or failed
    // reads are unverified, not an old unmuted route or a confirmed departure.
    session.chrome.health = {
      ...session.chrome.health,
      ...verifiedHealth,
      inCall: verifiedHealth?.inCall,
      micMuted: verifiedHealth?.micMuted,
      manualAction: verifiedHealth?.manualAction,
    };
    session.updatedAt = nowIso();
  }
}

export async function refreshTwilioVoiceCallStatus(
  { params, sessions, voiceCallGateway }: GoogleMeetRuntimeTransportContext,
  session: GoogleMeetSession,
): Promise<void> {
  const callId = session.twilio?.voiceCallId;
  if (!callId || session.state !== "active") {
    sessions.refreshSpeechReadiness(session);
    return;
  }
  try {
    const status = await getMeetingVoiceCallGatewayCall({
      gateway: voiceCallGateway,
      callId,
    });
    const call = asOptionalRecord(status.call);
    if (status.found === false || call?.endedAt !== undefined || call?.endReason !== undefined) {
      sessions.markSessionEnded(session, "Voice Call is no longer active.");
    }
  } catch (error) {
    params.logger.debug?.(
      `[google-meet] voice-call status refresh ignored: ${formatErrorMessage(error)}`,
    );
  }
  sessions.refreshSpeechReadiness(session);
}

export async function speakViaTransport(
  { params, sessions, voiceCallGateway }: GoogleMeetRuntimeTransportContext,
  session: GoogleMeetSession,
  instructions?: string,
): Promise<{ handled: boolean; spoken: boolean } | undefined> {
  if (session.transport !== "twilio" || !session.twilio?.voiceCallId) {
    return undefined;
  }
  try {
    await speakMeetingViaVoiceCallGateway({
      gateway: voiceCallGateway,
      callId: session.twilio.voiceCallId,
      message:
        instructions ||
        params.config.voiceCall.introMessage ||
        params.config.realtime.introMessage ||
        "",
    });
  } catch (error) {
    if (!isMeetingVoiceCallMissingError(error)) {
      throw error;
    }
    sessions.markSessionEnded(session, "Voice Call is no longer active.");
    return { handled: true, spoken: false };
  }
  session.twilio.introSent = true;
  session.updatedAt = nowIso();
  return { handled: true, spoken: true };
}

export async function captureTranscript(
  { params }: GoogleMeetRuntimeTransportContext,
  session: GoogleMeetSession,
  options: { finalize?: boolean } = {},
) {
  const tab = session.chrome?.browserTab;
  if (!tab) {
    return undefined;
  }
  return await readChromeMeetTranscript({
    runtime: params.runtime,
    ...(session.transport === "chrome-node"
      ? { transport: "chrome-node", nodeId: session.chrome?.nodeId }
      : {}),
    config: params.config,
    ...(options.finalize === undefined ? {} : { finalize: options.finalize }),
    meetingUrl: session.url,
    meetingSessionId: session.id,
    tab,
  });
}

export async function releaseBrowserTab(
  { params, sessions }: GoogleMeetRuntimeTransportContext,
  session: GoogleMeetSession,
): Promise<boolean | undefined> {
  if (!isBrowserTransport(session.transport)) {
    return undefined;
  }
  const tab = session.chrome?.browserTab;
  if (!tab) {
    noteSession(
      session,
      "No tracked Meet browser tab for this session; close the Meet tab manually if it is still in the call.",
    );
    session.browserLeft = false;
    return false;
  }
  const shared = sessions
    .list()
    .some(
      (other) =>
        other.id !== session.id &&
        other.state === "active" &&
        isBrowserTransport(other.transport) &&
        other.chrome?.browserTab?.targetId === tab.targetId &&
        other.chrome?.nodeId === session.chrome?.nodeId,
    );
  if (shared) {
    noteSession(session, "Kept the shared Meet tab open because another active session uses it.");
    session.browserLeft = undefined;
    return undefined;
  }
  let left: boolean;
  try {
    const result = await leaveChromeMeet({
      runtime: params.runtime,
      ...(session.transport === "chrome-node"
        ? { transport: "chrome-node", nodeId: session.chrome?.nodeId }
        : {}),
      config: params.config,
      meetingSessionId: session.id,
      meetingUrl: session.url,
      tab,
    });
    noteSession(session, result.note);
    left = result.left;
  } catch (error) {
    noteSession(
      session,
      `Browser control could not leave the Meet tab: ${formatErrorMessage(error)}`,
    );
    left = false;
  }
  if (session.chrome && left) {
    session.chrome.browserTab = undefined;
    if (session.chrome.health) {
      session.chrome.health = {
        ...session.chrome.health,
        captioning: false,
        audioOutputRouted: false,
        providerConnected: false,
        realtimeReady: false,
        audioInputActive: false,
        audioOutputActive: false,
      };
    }
  }
  session.browserLeft = left;
  return left;
}
