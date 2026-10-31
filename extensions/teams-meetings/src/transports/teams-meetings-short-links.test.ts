import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { TEAMS_MEETINGS_PLATFORM_ADAPTER } from "./teams-meetings-platform-adapter.js";
import {
  control,
  runStatusScript,
  runLeaveScript,
  MEETING_STATE_KEY,
  URL as LEGACY_URL,
  CONSUMER_URL,
} from "./teams-meetings-platform-adapter.test-helpers.js";
import {
  normalizeTeamsMeetingUrl,
  normalizeTeamsMeetingUrlForReuse,
  isSameTeamsMeetingUrl,
  isRecoverableTeamsMeetingTab,
} from "./teams-meetings-urls.js";

const SHORT = "https://teams.microsoft.com/meet/1234567890123?p=Synthetic_opaque-Token";
const identity = "teams-work:meet:1234567890123:p:Synthetic_opaque-Token";
const OTHER = SHORT.replace("Synthetic_opaque-Token", "Different-token");
const invalid = [
  SHORT.replace("https:", "http:"),
  SHORT.replace("teams.microsoft.com", "evil.example"),
  SHORT.replace("teams.microsoft.com", "teams.microsoft.com.evil.example"),
  SHORT.replace("teams.microsoft.com", "sub.teams.microsoft.com"),
  SHORT.replace("teams.microsoft.com", "teams.microsoft.com@evil.example"),
  SHORT.replace("teams.microsoft.com", "user@teams.microsoft.com"),
  SHORT.replace("teams.microsoft.com", "user:secret@teams.microsoft.com"),
  SHORT.replace("teams.microsoft.com", "teams.microsoft.com:444"),
  SHORT.replace("teams.microsoft.com", "%74eams.microsoft.com"),
  SHORT.replace("/meet/", "/x/../meet/"),
  SHORT.replace("/meet/", "/%6deet/"),
  SHORT.replace("1234567890123", "%31"),
  SHORT.replace("1234567890123", "abc"),
  SHORT.replace("1234567890123", "12%2f34"),
  SHORT.replace("1234567890123", ""),
  SHORT.replace("1234567890123", "12.34"),
  SHORT.replace("1234567890123", "１２３"),
  SHORT.slice(0, SHORT.indexOf("?")),
  SHORT.slice(0, SHORT.indexOf("?")) + "?p=",
  SHORT + "&p=other",
  SHORT + "&%70=other",
  SHORT.replace("Synthetic_opaque-Token", "%00"),
  SHORT.replace("Synthetic_opaque-Token", "%20"),
  SHORT.replace("Synthetic_opaque-Token", "%ZZ"),
  SHORT.replace("Synthetic_opaque-Token", "%FF"),
  SHORT.replace("Synthetic_opaque-Token", "a+b"),
  SHORT.replace("/meet/", "\\meet/"),
];
// The work-host short-link/launcher-redirect browser-context recognition
// (formerly exercised here via a now-removed export that lived in this file
// pre-refactor) now lives as an inline mirror inside
// teams-meetings-page-scripts.ts's pageIdentitySource and is covered directly in
// teams-meetings-urls.test.ts and by extracting/evaluating that literal source.
describe("new work meeting links", () => {
  it.each([
    SHORT,
    SHORT + "#ignored",
    SHORT + "&tracking=%ZZ",
    SHORT.replace("?p=", "/?tracking=x&p=") + "&anon=true",
    SHORT.replace("teams.microsoft.com", "TEAMS.MICROSOFT.COM:443"),
  ])("preserves identity and join secret: %s", (url) => {
    expect(normalizeTeamsMeetingUrlForReuse(url)).toBe(identity);
    expect(new URL(normalizeTeamsMeetingUrl(url)).searchParams.get("p")).toBe(
      "Synthetic_opaque-Token",
    );
    expect(new URL(normalizeTeamsMeetingUrl(url)).hash).toBe("");
  });
  it.each(invalid)("rejects ambiguous or unsafe input: %s", (url) => {
    expect(normalizeTeamsMeetingUrlForReuse(url)).toBeUndefined();
    expect(() => normalizeTeamsMeetingUrl(url)).toThrow();
  });
  it("does not impose an undocumented passcode alphabet, length or numeric ID width", () => {
    for (const id of ["1", "000123", "12345678901234567890"]) {
      const url = `https://teams.microsoft.com/meet/${id}?p=${encodeURIComponent("opaque+/=:?&#%é")}`;
      expect(normalizeTeamsMeetingUrlForReuse(url)).toBe(
        `teams-work:meet:${id}:p:${encodeURIComponent("opaque+/=:?&#%é")}`,
      );
    }
  });
  it("compares decoded query values, not query order or tracking parameters", () => {
    expect(isSameTeamsMeetingUrl(SHORT, SHORT.replace("?p=S", "?tracking=x&p=%53"))).toBe(true);
    for (const url of [
      OTHER,
      SHORT.replace("1234567890123", "1234567890124"),
      SHORT.replace("microsoft", "live"),
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_test%40thread.v2/0",
    ]) {
      expect(isSameTeamsMeetingUrl(SHORT, url)).toBe(false);
      expect(isRecoverableTeamsMeetingTab({ url }, SHORT)).toBe(false);
    }
    expect(isRecoverableTeamsMeetingTab({ url: SHORT + "&tracking=x" }, SHORT)).toBe(true);
    expect(isRecoverableTeamsMeetingTab({ url: "https://teams.microsoft.com/v2/" }, SHORT)).toBe(
      false,
    );
    expect(TEAMS_MEETINGS_PLATFORM_ADAPTER.urls.validateAndNormalize(SHORT)).toBe(SHORT);
  });
  it("stamps the short identity and retains it only through an owned in-call transition", async () => {
    const prejoin = await runStatusScript({ currentUrl: SHORT, meetingUrl: SHORT });
    expect(prejoin.window[MEETING_STATE_KEY]).toMatchObject({ identity, sessionId: "session-1" });
    const leave = control({ label: "Leave" });
    const admitted = await runStatusScript({
      currentUrl: "https://teams.microsoft.com/v2/",
      meetingUrl: SHORT,
      leave,
      priorMeeting: prejoin.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(admitted.result.inCall).toBe(true);
    const departed = runLeaveScript({
      currentUrl: "https://teams.microsoft.com/v2/",
      meetingUrl: SHORT,
      leave,
      priorMeeting: admitted.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(departed.result).toMatchObject({
      leaveAction: "leave",
      urlMatched: true,
      departed: false,
    });
    expect(leave.clicks).toBe(1);
  });
  it.each([SHORT, LEGACY_URL, CONSUMER_URL])(
    "preserves login guidance without granting meeting controls: %s",
    async (meetingUrl) => {
      const currentUrl = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
      const leave = control({ label: "Leave" });
      const join = control({ label: "Join now" });
      const microphone = control({ label: "Mute", pressed: true });
      const camera = control({ label: "Turn camera off", pressed: true });
      const priorMeeting = {
        identity: normalizeTeamsMeetingUrlForReuse(meetingUrl),
        sessionId: "session-1",
        inCallControl: leave,
        inCallUrl: currentUrl,
        verifiedAt: Date.now(),
      };
      const page = await runStatusScript({
        currentUrl,
        meetingUrl,
        priorMeeting,
        leave,
        join,
        microphone,
        camera,
        captureCaptions: true,
        captionRows: [],
        allowMicrophone: true,
      });
      expect(page.result).toMatchObject({
        inCall: false,
        manualAction: { reason: "teams-audio-choice-required" },
      });
      expect(page.window).not.toHaveProperty(MEETING_STATE_KEY);
      expect(page.window).not.toHaveProperty("__openclawTeamsCaptions");
      expect(page.captionButton.clicks).toBe(0);
      runLeaveScript({ currentUrl, meetingUrl, priorMeeting, leave });
      for (const button of [leave, join, microphone, camera]) {
        expect(button.clicks).toBe(0);
      }
    },
  );
  it("does not adopt a different passcode or mutate a newer page owner", async () => {
    const leave = control({ label: "Leave" });
    const priorMeeting = {
      identity: normalizeTeamsMeetingUrlForReuse(OTHER),
      sessionId: "session-2",
    };
    const page = await runStatusScript({
      currentUrl: OTHER,
      meetingUrl: SHORT,
      leave,
      priorMeeting,
      allowSessionAdoption: false,
    });
    expect(page.result.manualAction).toMatchObject({ reason: "teams-session-conflict" });
    expect(page.window[MEETING_STATE_KEY]).toBe(priorMeeting);
    runLeaveScript({ currentUrl: OTHER, meetingUrl: SHORT, leave, priorMeeting });
    expect(leave.clicks).toBe(0);
  });
  it("rejects ownership theft for the same short link", async () => {
    const leave = control({ label: "Leave" });
    const priorMeeting = { identity, sessionId: "session-2" };
    const page = await runStatusScript({
      currentUrl: SHORT,
      meetingUrl: SHORT,
      leave,
      priorMeeting,
      allowSessionAdoption: false,
    });
    expect(page.result.manualAction).toMatchObject({ reason: "teams-session-conflict" });
    runLeaveScript({ currentUrl: SHORT, meetingUrl: SHORT, leave, priorMeeting });
    expect(leave.clicks).toBe(0);
  });
  it("does not infer ownership on an unrecognized launch route without a marker", async () => {
    const page = await runStatusScript({
      currentUrl: "https://teams.microsoft.com/v2/",
      meetingUrl: SHORT,
      leave: control({ label: "Leave" }),
    });
    expect(page.result.inCall).toBe(false);
    expect(page.window).not.toHaveProperty(MEETING_STATE_KEY);
  });
  it.each([
    OTHER.slice(0, OTHER.indexOf("?")),
    OTHER + "&p=duplicate",
    "https://evil.example/v2/",
    "https://teams.microsoft.com/unrelated",
    "https://user@teams.microsoft.com/v2/",
  ])("does not retain a short-link marker on unsafe navigation: %s", async (currentUrl) => {
    // A real browser navigation to an unrelated page destroys the prior DOM, so the
    // previously-retained Leave control is no longer connected; without that connected
    // control, none of the current-build's identity-adoption/rerender leniency paths
    // (status-prejoin-source.ts) can fire, and inCall must correctly drop to false.
    const leave = control({ label: "Leave" });
    leave.isConnected = false;
    const priorMeeting = { identity, sessionId: "session-1", verifiedAt: Date.now() };
    const page = await runStatusScript({ currentUrl, meetingUrl: SHORT, leave, priorMeeting });
    expect(page.result.inCall).toBe(false);
    expect(leave.clicks).toBe(0);
    runLeaveScript({
      currentUrl,
      meetingUrl: SHORT,
      leave,
      priorMeeting: { ...priorMeeting, inCallUrl: currentUrl, inCallControl: leave },
    });
    expect(leave.clicks).toBe(0);
  });
  // Note: this suite previously also exercised audioCapture ownership gating here via
  // TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.buildAudioCaptureScript, a per-plugin script
  // builder that the current MeetingPlatformAdapter refactor does not expose in this shape
  // (createPageScripts's audioCapture path is now generic SDK-level, built from
  // normalizeUrl/pageIdentitySource rather than a plugin-provided buildAudioCaptureScript).
  // That generic ownership gating is exercised by the shared SDK's own tests, not this
  // plugin's; re-adding plugin-local coverage here would require first establishing the
  // current generic audioCapture contract, which is out of scope for this URL-compatibility
  // fix. Work-host short-link identity correctness itself remains covered above and in
  // teams-meetings-urls.test.ts.
});
