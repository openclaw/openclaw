import {
  createMeetingBrowserAudioCaptureSource,
  type MeetingBrowserAudioCaptureRequest,
  createMeetingLeaveSource,
  createMeetingTranscriptSource,
} from "openclaw/plugin-sdk/meeting-page-script-runtime";
import { TEAMS_MEETING_SELECTORS } from "./teams-meetings-selectors.js";
import { teamsMeetingStatusCallSource } from "./teams-meetings-status-call-source.js";
import { teamsMeetingStatusPreludeSource } from "./teams-meetings-status-prejoin-source.js";
import {
  normalizeTeamsMeetingUrlForReuse,
  teamsMeetingIdentityFunctionSource,
} from "./teams-meetings-urls.js";

export function teamsMeetingAudioCaptureScript(params: MeetingBrowserAudioCaptureRequest): string {
  return createMeetingBrowserAudioCaptureSource({
    ...params,
    audioOutputsGlobal: "__openclawTeamsAudioOutputs",
    ownershipSource: `
      ${teamsMeetingIdentityFunctionSource(params.meetingUrl)}
      const expectedIdentity = ${JSON.stringify(normalizeTeamsMeetingUrlForReuse(params.meetingUrl))};
      const state = window.__openclawTeamsMeeting;
      const currentIdentity = meetingIdentity(location.href);
      return Boolean(expectedIdentity && state?.sessionId === sessionId &&
        state.identity === expectedIdentity && !state.leavePending &&
        (currentIdentity === expectedIdentity ||
          (!currentIdentity && state.inCallUrl === location.href && state.inCallControl?.isConnected)));
    `,
  });
}

function teamsMeetingToggleStateFunctionSource(): string {
  return `(input) => {
    const pressed = String(input?.ariaPressed || "").toLowerCase();
    if (pressed === "true") return "on";
    if (pressed === "false") return "off";
    const checked = String(input?.ariaChecked ?? input?.checked ?? "").toLowerCase();
    if (checked === "true") return "on";
    if (checked === "false") return "off";
    const value = String(input?.label || "").toLowerCase().replace(/\\s+/g, " ").trim();
    if (!value) return undefined;
    if (input?.kind === "camera") {
      if (/\\bturn (?:your )?camera off\\b|\\bturn off (?:your )?camera\\b|\\bstop video\\b|\\bdisable (?:your )?(?:camera|video)\\b/.test(value)) return "on";
      if (/\\bturn (?:your )?camera on\\b|\\bturn on (?:your )?camera\\b|\\bstart video\\b|\\benable (?:your )?(?:camera|video)\\b/.test(value)) return "off";
      if (/\\b(?:camera|video) (?:is |currently )?(?:off|disabled)\\b/.test(value)) return "off";
      if (/\\b(?:camera|video) (?:is |currently )?(?:on|enabled)\\b/.test(value)) return "on";
      return undefined;
    }
    if (/^mute$|\\bturn (?:your )?(?:microphone|mic) off\\b|\\bturn off (?:your )?(?:microphone|mic)\\b|\\bmute (?:your )?(?:microphone|mic)\\b|\\bdisable (?:your )?(?:microphone|mic)\\b/.test(value)) return "on";
    if (/^unmute$|\\bturn (?:your )?(?:microphone|mic) on\\b|\\bturn on (?:your )?(?:microphone|mic)\\b|\\bunmute (?:your )?(?:microphone|mic)\\b|\\benable (?:your )?(?:microphone|mic)\\b/.test(value)) return "off";
    if (/\\b(?:microphone|mic) (?:is |currently )?(?:off|muted|disabled)\\b/.test(value)) return "off";
    if (/\\b(?:microphone|mic) (?:is |currently )?(?:on|unmuted|enabled)\\b/.test(value)) return "on";
    return undefined;
  }`;
}

export function teamsMeetingStatusScript(params: {
  allowMicrophone: boolean;
  allowSessionAdoption: boolean;
  autoJoin: boolean;
  captureCaptions: boolean;
  guestName: string;
  meetingSessionId?: string;
  meetingUrl: string;
  readOnly?: boolean;
  waitForInCallMs: number;
}) {
  const selectors = JSON.stringify(TEAMS_MEETING_SELECTORS);
  const expectedIdentity = normalizeTeamsMeetingUrlForReuse(params.meetingUrl);
  const toggleStateFunction = teamsMeetingToggleStateFunctionSource();
  const statusSource =
    teamsMeetingStatusPreludeSource({
      ...params,
      expectedIdentity,
      pageIdentitySource: teamsMeetingIdentityFunctionSource(params.meetingUrl),
      selectors,
      toggleStateFunction,
    }) + teamsMeetingStatusCallSource();
  // Classify sign-in only after the shared status guard has denied ownership
  // and retired this session's resources. Login pages never gain call authority.
  return `async () => {
    const result = JSON.parse(await (${statusSource})());
    const hostname = location.hostname.toLowerCase();
    if (result.manualAction?.reason === "teams-session-conflict" &&
        (hostname === "login.microsoftonline.com" || hostname.endsWith(".microsoftonline.com"))) {
      result.manualAction = {
        reason: "teams-login-required",
        message: "Sign in to Microsoft Teams in the OpenClaw browser profile, then retry the meeting join.",
      };
    }
    return JSON.stringify(result);
  }`;
}

export function teamsMeetingTranscriptScript(
  meetingUrl: string,
  meetingSessionId: string,
  finalize: boolean,
) {
  const expectedIdentity = normalizeTeamsMeetingUrlForReuse(meetingUrl);
  return createMeetingTranscriptSource({
    expectedIdentity,
    finalize,
    globals: {
      captionArchive: "__openclawTeamsCaptionArchive",
      captions: "__openclawTeamsCaptions",
      meeting: "__openclawTeamsMeeting",
    },
    meetingSessionId,
    pageIdentitySource: teamsMeetingIdentityFunctionSource(meetingUrl),
    platformDisplayName: "Teams",
  });
}

export function teamsMeetingLeaveScript(params: {
  leaveInitiated: boolean;
  meetingSessionId: string;
  meetingUrl: string;
}) {
  const selectors = JSON.stringify(TEAMS_MEETING_SELECTORS);
  const expectedIdentity = normalizeTeamsMeetingUrlForReuse(params.meetingUrl);
  return createMeetingLeaveSource({
    controlSource: `const first = (list) => {
    for (const selector of list) {
      const node = document.querySelector(selector);
      if (!node) continue;
      return node.matches?.("button") ? node : node.querySelector?.("button") || node.closest?.("button") || node;
    }
    return undefined;
  };
  const leave = first(selectors.leave);
  const confirmation = first(selectors.leaveConfirmation);
  const postCall = first(selectors.postCall);
  const currentUrlMatches = Boolean(expectedIdentity && currentIdentity === expectedIdentity);`,
    departedMarkerSource: "postCall",
    expectedIdentity,
    leaveInitiated: params.leaveInitiated,
    meetingSessionId: params.meetingSessionId,
    pageIdentitySource: teamsMeetingIdentityFunctionSource(params.meetingUrl),
    platform: {
      displayName: "Teams",
      globals: {
        audioOutputs: "__openclawTeamsAudioOutputs",
        meeting: "__openclawTeamsMeeting",
      },
    },
    selectors,
    sessionMatchSource:
      "const sessionMatched = !enforceSessionOwnership || state?.sessionId === expectedSessionId;",
  });
}
