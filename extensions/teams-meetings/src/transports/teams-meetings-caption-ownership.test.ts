import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { teamsMeetingPageScripts } from "./teams-meetings-page-scripts.js";
import {
  CONSUMER_URL,
  URL,
  runCaptionStatusScript,
} from "./teams-meetings-platform-adapter.test-helpers.js";

const identity = "teams-work:19:meeting_test@thread.v2";

async function adoptCaptions(
  captionOverrides: { identity?: string; observer?: { disconnect(): void } } = {},
  options: Parameters<typeof runCaptionStatusScript>[0] = {},
) {
  const sessionId = "old-session";
  const old = {
    droppedLines: 0,
    lines: [],
    observerInstalled: true,
    sessionId,
    visible: [{ text: "Old caption" }],
    ...captionOverrides,
  };
  const { window } = await runCaptionStatusScript({
    priorCaptions: old,
    priorMeeting: { identity, sessionId },
    ...options,
  });
  return { old, window };
}

function archivedTranscript(window: Record<string, unknown>, sessionId: string, currentUrl = URL) {
  delete window["__openclawTeamsCaptions"];
  const read = runInNewContext(`(${teamsMeetingPageScripts.transcript(URL, sessionId, false)})`, {
    URL: globalThis.URL,
    clearTimeout,
    location: new globalThis.URL(currentUrl),
    window,
  }) as () => string;
  return JSON.parse(read());
}

it("rotates live captions when the verified tab adopts a new session", async () => {
  const disconnect = vi.fn();
  const { old, window } = await adoptCaptions({ observer: { disconnect } });
  const current = window["__openclawTeamsCaptions"] as Record<string, unknown>;

  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(old).toMatchObject({ finalized: true, lines: [{ text: "Old caption" }] });
  expect(current).not.toBe(old);
  expect(current.sessionId).toBe("session-1");
  expect(window["__openclawTeamsCaptionArchive"]).toMatchObject({ "old-session": old });
  expect(archivedTranscript(window, "old-session")).toMatchObject({
    sessionMatched: true,
    lines: [{ text: "Old caption" }],
  });
});

it("archives a prior meeting caption buffer without rewriting its identity", async () => {
  const { old, window } = await adoptCaptions(
    { identity },
    {
      currentUrl: CONSUMER_URL,
      meetingSessionId: "session-b",
      meetingUrl: CONSUMER_URL,
    },
  );

  expect(old).toMatchObject({ finalized: true, identity, lines: [{ text: "Old caption" }] });
  expect(archivedTranscript(window, "old-session", CONSUMER_URL)).toMatchObject({
    sessionMatched: true,
    urlMatched: true,
    lines: [{ text: "Old caption" }],
  });
});
