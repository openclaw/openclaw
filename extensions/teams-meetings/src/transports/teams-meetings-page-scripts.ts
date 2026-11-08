import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { TEAMS_MEETING_SELECTORS } from "./teams-meetings-selectors.js";
import { teamsMeetingStatusPrelude } from "./teams-meetings-status-prejoin-source.js";
import { normalizeTeamsMeetingUrlForReuse } from "./teams-meetings-urls.js";

export const teamsMeetingPageScripts = MeetingPlatformAdapter.createPageScripts({
  platform: {
    audioOutputElementIdPrefix: "openclaw-teams-audio-output-",
    manualActionReasonPrefix: "teams",
    displayName: "Teams",
    globals: {
      audioOutputs: "__openclawTeamsAudioOutputs",
      captionArchive: "__openclawTeamsCaptionArchive",
      captions: "__openclawTeamsCaptions",
      meeting: "__openclawTeamsMeeting",
    },
  },
  normalizeUrl: normalizeTeamsMeetingUrlForReuse,
  pageIdentitySource: () => `const meetingIdentity = (rawUrl) => {
    try {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname.toLowerCase();
      if (parsed.protocol !== "https:") return undefined;
      if (host === "teams.microsoft.com") {
        const match = parsed.pathname.match(/^\\/l\\/meetup-join\\/([^/]+)(?:\\/0)?\\/?$/i);
        if (!match?.[1]) return undefined;
        const threadId = decodeURIComponent(match[1]);
        return /^19:[^/]+@thread\\.(?:v2|tacv2)$/i.test(threadId)
          ? "teams-work:" + threadId
          : undefined;
      }
      if (host === "teams.live.com") {
        const launcherTarget = parsed.pathname.toLowerCase() === "/dl/launcher/launcher.html"
          ? parsed.searchParams.get("url")
          : undefined;
        const launcherMatch = launcherTarget?.match(/^\\/_#\\/meet\\/([^/?#]+)(?:\\?(.+))?$/i);
        let lightMeeting;
        if (parsed.pathname.toLowerCase() === "/light-meetings/launch") {
          try {
            const coordinates = parsed.searchParams.get("coords");
            const decoded = coordinates && coordinates.length <= 16_384
              ? JSON.parse(atob(coordinates))
              : undefined;
            if (decoded && typeof decoded === "object") lightMeeting = decoded;
          } catch { /* Invalid external coordinates do not identify a meeting. */ }
        }
        const match = parsed.pathname.match(/^\\/meet\\/([^/]+)\\/?$/i) || launcherMatch ||
          (typeof lightMeeting?.meetingCode === "string"
            ? [undefined, lightMeeting.meetingCode]
            : undefined);
        if (!match?.[1]) return undefined;
        const code = decodeURIComponent(match[1]);
        const passcode = launcherMatch
          ? new URLSearchParams(launcherMatch[2] || "").get("p")
          : typeof lightMeeting?.passcode === "string"
            ? lightMeeting.passcode
            : parsed.searchParams.get("p");
        return /^[a-z0-9_-]+$/i.test(code)
          ? "teams-consumer:" + code.toLowerCase() + ":p:" + encodeURIComponent(passcode || "")
          : undefined;
      }
    } catch { /* Invalid external URLs do not identify a meeting. */ }
    return undefined;
  };`,
  selectors: TEAMS_MEETING_SELECTORS,
  toggleStateFunction: () => `(input) => {
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
  }`,
  statusPrelude: teamsMeetingStatusPrelude,
  statusCall: {
    captionEnableSource: `if (!captionsFinalized && canMutateSession && inCall && !captionsEnabledNow) {
      let captionButton = first(selectors.captions);
      if (!captionButton) {
        first(selectors.moreActions)?.click?.();
        await waitForUi();
        captionButton = first(selectors.captions);
      }
      if (captionButton) {
        const captionLabel = label(captionButton);
        const alreadyEnabled = captionButton.getAttribute?.("aria-checked") === "true" ||
          /hide live captions|turn off captions/i.test(captionLabel) ||
          Boolean(firstRaw(selectors.captionsOff));
        if (!alreadyEnabled) {
          captionButton.click();
          await waitForUi();
        }
        const currentLabel = label(captionButton);
        captionsEnabledNow = captionButton.getAttribute?.("aria-checked") === "true" ||
          /hide live captions|turn off captions/i.test(currentLabel) ||
          Boolean(firstRaw(selectors.captionRenderer)) ||
          Boolean(firstRaw(selectors.captionsOff));
        if (captionsEnabledNow && !alreadyEnabled) {
          notes.push("Enabled Teams live captions for transcript capture.");
        }
      }
    }`,
  },
  leave: {
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
    sessionMatchSource:
      "const sessionMatched = !enforceSessionOwnership || state?.sessionId === expectedSessionId;",
  },
});
