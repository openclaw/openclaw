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
  teamsMeetingIdentityFunctionSource,
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
function browserIdentity(url: string) {
  return runInNewContext(
    `${teamsMeetingIdentityFunctionSource()}; meetingIdentity(${JSON.stringify(url)})`,
    { URL, URLSearchParams, atob },
  );
}
describe("new work meeting links", () => {
  it.each([
    SHORT,
    SHORT + "#ignored",
    SHORT + "&tracking=%ZZ",
    SHORT.replace("?p=", "/?tracking=x&p=") + "&anon=true",
    SHORT.replace("teams.microsoft.com", "TEAMS.MICROSOFT.COM:443"),
  ])("preserves identity and join secret: %s", (url) => {
    expect(normalizeTeamsMeetingUrlForReuse(url)).toBe(identity);
    expect(browserIdentity(url)).toBe(identity);
    expect(new URL(normalizeTeamsMeetingUrl(url)).searchParams.get("p")).toBe(
      "Synthetic_opaque-Token",
    );
    expect(new URL(normalizeTeamsMeetingUrl(url)).hash).toBe("");
  });
  it.each(invalid)("rejects ambiguous or unsafe input in both runtimes: %s", (url) => {
    expect(normalizeTeamsMeetingUrlForReuse(url)).toBeUndefined();
    expect(browserIdentity(url)).toBeUndefined();
    expect(() => normalizeTeamsMeetingUrl(url)).toThrow();
  });
  it("does not impose an undocumented passcode alphabet, length or numeric ID width", () => {
    for (const id of ["1", "000123", "12345678901234567890"]) {
      const url = `https://teams.microsoft.com/meet/${id}?p=${encodeURIComponent("opaque+/=:?&#%é")}`;
      expect(browserIdentity(url)).toBe(normalizeTeamsMeetingUrlForReuse(url));
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
  it.each([
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_test%40thread.v2/0",
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_test%40thread.tacv2/0",
    "https://teams.live.com/meet/abc?p=opaque%2B",
    "https://teams.live.com/dl/launcher/launcher.html?url=%2F_%23%2Fmeet%2Fabc%3Fp%3Dopaque%252B",
    `https://teams.live.com/light-meetings/launch?coords=${encodeURIComponent(Buffer.from(JSON.stringify({ meetingCode: "abc", passcode: "opaque+é" }), "utf8").toString("base64"))}`,
  ])("preserves legacy/consumer browser parity: %s", (url) => {
    expect(browserIdentity(url)).toBe(normalizeTeamsMeetingUrlForReuse(url));
    expect(browserIdentity(url)).toBeTruthy();
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
        manualAction: { reason: "teams-login-required" },
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
    const leave = control({ label: "Leave" });
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
  it.each([
    SHORT,
    OTHER,
    OTHER.slice(0, OTHER.indexOf("?")),
    "https://teams.microsoft.com/v2/",
    "https://evil.example/v2/",
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  ])(
    "gates audio capture against current identity even with a retained control: %s",
    async (currentUrl) => {
      const source = TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.buildAudioCaptureScript?.({
        action: "start",
        captureId: "capture-1",
        meetingSessionId: "session-1",
        meetingUrl: SHORT,
      });
      const result = runInNewContext(`(${source})()`, {
        URL,
        URLSearchParams,
        atob,
        location: { href: currentUrl },
        window: {
          __openclawTeamsMeeting: {
            identity,
            sessionId: "session-1",
            inCallUrl: currentUrl,
            inCallControl: { isConnected: true },
          },
        },
        AudioContext: function AudioContext() {
          throw new Error("capture admitted");
        },
      });
      await expect(result).rejects.toThrow(
        currentUrl === SHORT || currentUrl === "https://teams.microsoft.com/v2/"
          ? "capture admitted"
          : "no longer owns",
      );
    },
  );
});
