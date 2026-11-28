import { describe, expect, it } from "vitest";
import {
  control,
  runStatusScript,
  runLeaveScript,
  runAudioCaptureScript,
  MEETING_STATE_KEY,
} from "./teams-meetings-platform-adapter.test-helpers.js";
import {
  normalizeTeamsMeetingUrlForReuse,
  isSameTeamsMeetingUrl,
  isRecoverableTeamsMeetingTab,
} from "./teams-meetings-urls.js";

// Sanitized shape observed after a classic work invitation redirected on admission.
const thread = "19:meeting_SYNTHETIC@thread.v2";
const identity = "teams-work:" + thread;
const classic = "https://teams.microsoft.com/l/meetup-join/" + encodeURIComponent(thread) + "/0";
const coordinates = {
  conversationId: thread,
  tenantId: "synthetic",
  organizerId: "synthetic",
  messageId: "0",
};
const light = (json = JSON.stringify(coordinates)) =>
  "https://teams.microsoft.com/light-meetings/launch?coords=" + encodeURIComponent(btoa(json));
const other = light(
  JSON.stringify({ ...coordinates, conversationId: "19:meeting_OTHER@thread.v2" }),
);
const invalid = [
  light().replace("https:", "http:"),
  ...[
    "evil.example",
    "teams.microsoft.com.evil.example",
    "user@teams.microsoft.com",
    "teams.microsoft.com:444",
    "teams.live.com",
  ].map((host) => light().replace("teams.microsoft.com", host)),
  light().replace("/light-meetings/", "/%6cight-meetings/"),
  light() + "&coords=" + encodeURIComponent(btoa(JSON.stringify(coordinates))),
  light() + "&%63oords=duplicate",
  "https://teams.microsoft.com/light-meetings/launch",
  "https://teams.microsoft.com/light-meetings/launch?coords=not-base64!",
  "https://teams.microsoft.com/light-meetings/launch?coords=" + "A".repeat(16_385),
  ...[
    "null",
    "[]",
    "{}",
    "{",
    '{"conversationId":42}',
    '{"conversationId":"19:meeting_X@thread.v2","nested":{}}',
    JSON.stringify({ meetingCode: "123", passcode: "consumer" }),
    JSON.stringify({ ...coordinates, conversationId: "19:meeting_X/other@thread.v2" }),
    JSON.stringify({ ...coordinates, conversationId: "19:meeting_X\n@thread.v2" }),
    JSON.stringify(coordinates).replace(
      '"conversationId":',
      '"conversationId":"19:meeting_OTHER@thread.v2","conversationId":',
    ),
    JSON.stringify(coordinates).replace(
      '"conversationId":',
      '"conversationId":"19:meeting_OTHER@thread.v2","conversation\\u0049d":',
    ),
    JSON.stringify(coordinates).replace('"messageId":', '"messageId":"1","messageId":'),
    '{"conversationId":{"x":"19:fake@thread.v2"},"conversationId":"' + thread + '"}',
    '{"conversationId":["x","y"],"conversationId":"' + thread + '"}',
    '{"extra":{"x":"y"},"extra":"safe","conversationId":"' + thread + '"}',
  ].map((json) => light(json)),
];

describe("work light-meeting redirects", () => {
  it("rejects input spellings repaired by URL before browser navigation", () => {
    for (const url of [
      light().replace("teams.microsoft.com", "%74eams.microsoft.com"),
      light().replace("/light-meetings/", "/x/../light-meetings/"),
    ]) {
      expect(normalizeTeamsMeetingUrlForReuse(url)).toBeUndefined();
    }
  });
  it("recognizes the observed conversation for Node reuse and recovery", () => {
    expect(normalizeTeamsMeetingUrlForReuse(light())).toBe(identity);
    expect(isSameTeamsMeetingUrl(classic, light())).toBe(true);
    expect(isRecoverableTeamsMeetingTab({ url: light() }, classic)).toBe(true);
  });

  it("recognizes the observed conversation in the actual browser status/leave/audio scripts", async () => {
    for (const url of [
      light(),
      light() + "&anon=true",
      light().replace("teams.microsoft.com", "TEAMS.MICROSOFT.COM:443"),
    ]) {
      const leave = control({ label: "Leave" });
      const page = await runStatusScript({ meetingUrl: classic, currentUrl: url, leave });
      expect(page.result.inCall).toBe(true);
      expect(page.window[MEETING_STATE_KEY]).toMatchObject({ identity, sessionId: "session-1" });
      runLeaveScript({
        meetingUrl: classic,
        currentUrl: url,
        leave,
        priorMeeting: page.window[MEETING_STATE_KEY] as Record<string, unknown>,
      });
      expect(leave.clicks).toBe(1);
    }
    await expect(
      runAudioCaptureScript({
        meetingUrl: classic,
        currentUrl: light(),
        priorMeeting: { identity },
      }),
    ).rejects.toThrow("capture admitted");
  });

  it.each(invalid.map((url, index) => ({ url, index })))(
    "rejects unsafe or ambiguous coordinates in both parsers: $index",
    async ({ url }) => {
      expect(normalizeTeamsMeetingUrlForReuse(url)).toBeUndefined();
      expect(isRecoverableTeamsMeetingTab({ url }, classic)).toBe(false);
      const leave = control({ label: "Leave" });
      const page = await runStatusScript({ meetingUrl: classic, currentUrl: url, leave });
      expect(page.result.inCall).toBe(false);
      expect(page.window).not.toHaveProperty(MEETING_STATE_KEY);
      runLeaveScript({ meetingUrl: classic, currentUrl: url, leave, priorMeeting: { identity } });
      expect(leave.clicks).toBe(0);
      await expect(
        runAudioCaptureScript({ meetingUrl: classic, currentUrl: url, priorMeeting: { identity } }),
      ).rejects.toThrow("no longer owns");
    },
  );

  it("does not equate another conversation, a short meeting ID or consumer coordinates", async () => {
    for (const url of [
      other,
      "https://teams.microsoft.com/meet/123?p=opaque",
      light().replace("teams.microsoft.com", "teams.live.com"),
    ]) {
      expect(isSameTeamsMeetingUrl(classic, url)).toBe(false);
      const leave = control({ label: "Leave" });
      const page = await runStatusScript({ meetingUrl: classic, currentUrl: url, leave });
      expect(page.result.inCall).toBe(false);
      runLeaveScript({ meetingUrl: classic, currentUrl: url, leave, priorMeeting: { identity } });
      expect(leave.clicks).toBe(0);
      const staleControl = control({ label: "Leave" });
      staleControl.isConnected = false;
      await expect(
        runAudioCaptureScript({
          meetingUrl: classic,
          currentUrl: url,
          inCallControl: staleControl,
          priorMeeting: { identity },
        }),
      ).rejects.toThrow("no longer owns");
    }
  });

  it("preserves a newer session owner and denies stale leave/audio on the same conversation", async () => {
    const leave = control({ label: "Leave" });
    const priorMeeting = { identity, sessionId: "session-2" };
    const page = await runStatusScript({
      meetingUrl: classic,
      currentUrl: light(),
      leave,
      priorMeeting,
      allowSessionAdoption: false,
    });
    expect(page.result.manualAction).toMatchObject({ reason: "teams-session-conflict" });
    expect(page.window[MEETING_STATE_KEY]).toBe(priorMeeting);
    runLeaveScript({ meetingUrl: classic, currentUrl: light(), leave, priorMeeting });
    expect(leave.clicks).toBe(0);
    await expect(
      runAudioCaptureScript({ meetingUrl: classic, currentUrl: light(), priorMeeting }),
    ).rejects.toThrow("no longer owns");
    await expect(
      runAudioCaptureScript({
        meetingUrl: classic,
        currentUrl: light(),
        priorMeeting: { identity, leavePending: true },
      }),
    ).rejects.toThrow("no longer owns");
  });

  it("leaves consumer light-meeting identity unchanged and host-separated", async () => {
    const url = light(JSON.stringify({ meetingCode: "123", passcode: "opaque" })).replace(
      "teams.microsoft.com",
      "teams.live.com",
    );
    const consumer = "https://teams.live.com/meet/123?p=opaque";
    expect(normalizeTeamsMeetingUrlForReuse(url)).toBe("teams-consumer:123:p:opaque");
    const page = await runStatusScript({
      meetingUrl: consumer,
      currentUrl: url,
      leave: control({ label: "Leave" }),
    });
    expect(page.result.inCall).toBe(true);
    expect(page.window[MEETING_STATE_KEY]).toMatchObject({
      identity: "teams-consumer:123:p:opaque",
    });
    expect(
      normalizeTeamsMeetingUrlForReuse(url.replace("teams.live.com", "teams.microsoft.com")),
    ).toBeUndefined();
  });
});
