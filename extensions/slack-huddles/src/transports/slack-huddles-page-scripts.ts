import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { SLACK_HUDDLE_SELECTORS } from "./slack-huddles-selectors.js";
import { slackHuddleStatusCallSource } from "./slack-huddles-status-call-source.js";
import {
  SLACK_HUDDLE_JOIN_SETTLE_MS,
  slackHuddleStatusPreludeSource,
} from "./slack-huddles-status-prejoin-source.js";
import { normalizeSlackHuddleUrlForReuse } from "./slack-huddles-urls.js";

function pageIdentityFunctionSource(expectedIdentity: string | undefined): string {
  // Team-scoped requests need the page's team to match; a page URL without one fails closed.
  const teamScoped = /^slack-huddle:[TE][A-Z0-9]+:/.test(expectedIdentity ?? "");
  const ownershipHooks = JSON.stringify({
    inHuddle: SLACK_HUDDLE_SELECTORS.channelHeaderInHuddle,
    inCall: SLACK_HUDDLE_SELECTORS.inCall,
  });
  // Status, audio capture, captions, and leave all resolve ownership through this identity.
  return `const meetingIdentity = (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:" || url.port || url.username || url.password ||
          !/^[a-z0-9-]+\\.slack\\.com$/i.test(url.hostname)) return undefined;
      const match = url.pathname.match(/^\\/huddle\\/(?:([TE][A-Z0-9]{8,})\\/)?([CGD][A-Z0-9]{8,})\\/?$/) ||
        (url.hostname === "app.slack.com" && url.pathname.match(/^\\/client\\/([TE][A-Z0-9]{8,})\\/([CGD][A-Z0-9]{8,})(?:\\/.*)?$/));
      if (!match) return undefined;
      const key = ${teamScoped} ? (match[1] || "unknown-team") + ":" + match[2] : match[2];
      const identity = "slack-huddle:" + key;
      if (rawUrl !== location.href) return identity;
      const boundWorkspace = window.__openclawSlackHuddleWorkspaces?.[identity];
      if (boundWorkspace && match[1] !== boundWorkspace) return "slack-huddle-other-workspace:" + key;
      // The URL names only the viewed channel. While a call is live, only Slack's membership header for
      // that channel (or this session's own settling Join) vouches for it; anything else fails closed.
      const hooks = ${ownershipHooks};
      const found = (list) => list.some((selector) => document.querySelector(selector));
      const marker = window.__openclawSlackHuddle;
      const settlingJoin = marker?.identity === identity && marker.joinRequested === true &&
        Date.now() - (marker.joinRequestedAt || 0) < ${SLACK_HUDDLE_JOIN_SETTLE_MS};
      if (found(hooks.inHuddle)) return identity;
      // Live captions always need membership; a live call without it passes only while our Join settles.
      const captions = window.__openclawSlackHuddleCaptions;
      const captionsActive = Boolean(captions && captions.finalized !== true);
      return captionsActive || (found(hooks.inCall) && !settlingJoin)
        ? "slack-huddle-unverified:" + key
        : identity;
    } catch { return undefined; }
  };`;
}

export const {
  audioCapture: slackHuddleAudioCaptureScript,
  status: slackHuddleStatusScript,
  transcript: slackHuddleTranscriptScript,
  leave: slackHuddleLeaveScript,
} = MeetingPlatformAdapter.createPageScripts({
  platform: {
    displayName: "Slack huddle",
    globals: {
      audioOutputs: "__openclawSlackHuddleAudioOutputs",
      captionArchive: "__openclawSlackHuddleCaptionArchive",
      captions: "__openclawSlackHuddleCaptions",
      meeting: "__openclawSlackHuddle",
    },
  },
  normalizeUrl: normalizeSlackHuddleUrlForReuse,
  pageIdentitySource: pageIdentityFunctionSource,
  selectors: SLACK_HUDDLE_SELECTORS,
  toggleStateFunction: () => `(input) => {
      if (input?.ariaChecked === "true") return "on";
      if (input?.ariaChecked === "false") return "off";
      if (/^unmute microphone(?: unmute microphone)?$/i.test(input?.label || "")) return "off";
      if (/^mute microphone(?: mute microphone)?$/i.test(input?.label || "")) return "on";
      return undefined;
    }`,
  statusPreludeSource: slackHuddleStatusPreludeSource,
  statusCallSource: slackHuddleStatusCallSource,
  audioOwnershipSource: ({ expectedIdentity, pageIdentitySource }) => `
      ${pageIdentitySource}
      const expectedIdentity = ${JSON.stringify(expectedIdentity)};
      const state = window.__openclawSlackHuddle;
      // Audio never rides on the join-settle exception: Slack's header must show membership, and a
      // channel-only session must already be bound to its workspace.
      const member = ${JSON.stringify(SLACK_HUDDLE_SELECTORS.channelHeaderInHuddle)}
        .some((selector) => document.querySelector(selector));
      const workspaceBound = /^slack-huddle:[TE][A-Z0-9]+:/.test(expectedIdentity || "") ||
        Boolean(window.__openclawSlackHuddleWorkspaces?.[expectedIdentity]);
      return Boolean(expectedIdentity && state?.sessionId === sessionId &&
        state.identity === expectedIdentity && !state.leavePending &&
        meetingIdentity(location.href) === expectedIdentity && member && workspaceBound);
    `,
  leave: {
    // Leave buttons are global: only Slack's membership header for the requested channel authorizes
    // them, and departure needs proof too, so a view without that header keeps the session in the call.
    controlSource: `const firstMatch = (list) => list.map((selector) => document.querySelector(selector)).find(Boolean);
  const headerInHuddle = Boolean(expectedIdentity && currentIdentity === expectedIdentity &&
    firstMatch(selectors.channelHeaderInHuddle));
  // A channel-only session must still hold its workspace binding (lost on reload) to press Leave.
  const workspaceBound = /^slack-huddle:[TE][A-Z0-9]+:/.test(expectedIdentity || "") ||
    Boolean(window.__openclawSlackHuddleWorkspaces?.[expectedIdentity]);
  const member = headerInHuddle && workspaceBound;
  const switchPrompt = Boolean(firstMatch(selectors.confirmation) || firstMatch(selectors.multiDevice));
  const leave = member && !switchPrompt ? firstMatch(selectors.leave) : undefined;
  const confirmation = undefined;
  // Missing call controls can be a re-render, and a settling Join can still land; only Slack's header,
  // with no Join outstanding, proves the account left.
  const joinSettling = state?.identity === expectedIdentity && state.joinRequested === true &&
    Date.now() - (state.joinRequestedAt || 0) < ${SLACK_HUDDLE_JOIN_SETTLE_MS};
  const provenDeparted = Boolean(firstMatch(selectors.channelHeader)) && !headerInHuddle && !joinSettling;
  const currentUrlMatches = Boolean(expectedIdentity && currentIdentity === expectedIdentity);`,
    departedMarkerSource: "provenDeparted",
    meetingStateSource: "sessionId: expectedSessionId || state?.sessionId,",
    sessionMatchSource: `const sessionMatched = !enforceSessionOwnership ||
      state?.sessionId === expectedSessionId ||
      (!state?.sessionId && currentIdentity === expectedIdentity && (!state?.identity || state.identity === expectedIdentity));`,
  },
});
