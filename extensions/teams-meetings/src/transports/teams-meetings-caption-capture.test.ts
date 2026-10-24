import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { teamsMeetingPageScripts } from "./teams-meetings-page-scripts.js";
import { TEAMS_MEETINGS_PLATFORM_ADAPTER } from "./teams-meetings-platform-adapter.js";
import {
  URL,
  CONSUMER_URL,
  MEETING_STATE_KEY,
  control,
  captionRow as makeRow,
  runCaptionRows,
  runCaptionStatusScript,
  runStatusScript,
} from "./teams-meetings-platform-adapter.test-helpers.js";

function transcriptReader(
  window: Record<string, unknown>,
  { currentUrl = URL, finalize = false } = {},
) {
  return runInNewContext(`(${teamsMeetingPageScripts.transcript(URL, "session-1", finalize)})`, {
    URL: globalThis.URL,
    clearTimeout,
    location: new globalThis.URL(currentUrl),
    window,
  }) as () => string;
}

const captionRow = (text: string, id?: string, speaker = "OpenClaw QA") =>
  makeRow(speaker, text, id);
const CAPTIONS = "__openclawTeamsCaptions";
const disconnect = vi.fn();
beforeEach(() => disconnect.mockClear());
const identity = "teams-work:19:meeting_test@thread.v2";
const rerenderOwner = (
  inCallControl: ReturnType<typeof control>,
  inCallUrl: string,
  sessionId = "session-1",
) => ({ identity, inCallControl, inCallUrl, sessionId, verifiedAt: Date.now() });

function captionOwner(sessionId = "session-1", overrides: Record<string, unknown> = {}) {
  return {
    droppedLines: 0,
    lines: [],
    visible: [],
    sessionId,
    observer: { disconnect },
    observerInstalled: true,
    ...overrides,
  };
}

function changeCaption(
  row: ReturnType<typeof captionRow>,
  text: string,
  field = "closed-caption-text",
) {
  const node = row.querySelector(`[data-tid="${field}"]`);
  if (!node) {
    throw new Error(`expected caption ${field} control`);
  }
  node.textContent = text;
}

async function settledRows(rows: ReturnType<typeof captionRow>[]) {
  vi.useFakeTimers();
  const first = await runCaptionRows(rows, undefined, { captionsInitiallyOn: true });
  await vi.advanceTimersByTimeAsync(1_000);
  return first;
}

afterEach(() => vi.useRealTimers());

it("enables live captions and captures the validated Teams caption row DOM", async () => {
  const { result, window } = await runCaptionRows([captionRow("I")]);

  expect(result).toMatchObject({
    captioning: true,
    captionsEnabledAttempted: true,
    inCall: true,
    lastCaptionSpeaker: "OpenClaw QA",
    lastCaptionText: "I",
    transcriptLines: 1,
  });
  const readTranscript = transcriptReader(window);
  expect(JSON.parse(readTranscript())).toMatchObject({
    droppedLines: 0,
    epoch: "teams-caption-epoch",
    lines: [{ speaker: "OpenClaw QA", text: "I" }],
    sessionMatched: true,
    urlMatched: true,
  });
  expect(window[CAPTIONS]).toMatchObject({ identity: "teams-work:19:meeting_test@thread.v2" });
});

it("retries an unverified live-caption activation", async () => {
  const first = await runCaptionRows([captionRow("Retry captions")], undefined, {
    captionClickIgnored: true,
    captionsInitiallyOn: false,
  });
  expect(first.captionButton.clicks).toBe(1);
  expect(first.result).toMatchObject({ captioning: false, captionsEnabledAttempted: false });

  const second = await runCaptionRows([captionRow("Retry captions")], first, {
    captionsInitiallyOn: false,
    priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
  });
  expect(second.captionButton.clicks).toBe(1);
  expect(second.result).toMatchObject({ captioning: true, captionsEnabledAttempted: true });
});

it("bounds visible and committed caption rows together", async () => {
  const { result, window } = await runCaptionStatusScript({
    captionRows: Array.from({ length: 505 }, (_, index) => captionRow(`Bounded caption ${index}`)),
  });
  const state = window[CAPTIONS] as {
    droppedLines: number;
    lines: unknown[];
    visible: unknown[];
  };

  expect(state.lines).toHaveLength(0);
  expect(state.visible).toHaveLength(505);
  expect(state.droppedLines).toBe(0);
  expect(result.transcriptLines).toBe(505);
  const readTranscript = transcriptReader(window);
  const transcript = JSON.parse(readTranscript()) as { droppedLines: number; lines: unknown[] };
  expect(transcript.lines).toHaveLength(500);
  expect(transcript.droppedLines).toBe(5);
});

it("keeps the latest caption when Teams shortens a provisional row", async () => {
  const row = captionRow("We should leave today");
  const first = await settledRows([row]);
  changeCaption(row, "We should leave");
  const second = await runCaptionRows([row], first);

  expect(second.result).toMatchObject({
    lastCaptionText: "We should leave",
    transcriptLines: 1,
    recentTranscript: [{ speaker: "OpenClaw QA", text: "We should leave" }],
  });
});

it.each([false, true])("corrects a logical caption row in place (settled=%s)", async (settled) => {
  const rows = [captionRow("Logical row", "8", "OpenClaw Q")];
  const first = settled ? await settledRows(rows) : await runCaptionRows(rows);
  const second = await runCaptionRows([captionRow("Logical row replacement", "8")], first);
  expect(second.result).toMatchObject({
    transcriptLines: 1,
    lastCaptionText: "Logical row replacement",
    lastCaptionSpeaker: "OpenClaw QA",
    recentTranscript: [{ text: "Logical row replacement" }],
  });
});

it("deduplicates a settled logical row after temporary DOM removal", async () => {
  const first = await settledRows([captionRow("Virtual row return", "13")]);
  const missing = await runCaptionRows([], first);
  const returned = await runCaptionRows([captionRow("Virtual row return", "13")], missing);

  expect(returned.result.transcriptLines).toBe(1);
  expect(returned.result.recentTranscript).toMatchObject([{ text: "Virtual row return" }]);
});

it.each([
  ["after settling", "First utterance", "First utterance continued", true],
  ["during rapid reuse", "Rapid first utterance", "Rapid second utterance", false],
] as const)("commits a removed caption %s", async (_name, initial, replacement, settle) => {
  const row = captionRow(initial);
  if (settle) {
    vi.useFakeTimers();
  }
  const first = await runCaptionRows([row], undefined, settle ? { captionsInitiallyOn: true } : {});
  let previous = first;
  if (settle) {
    previous = await runCaptionRows([], first);
    await vi.advanceTimersByTimeAsync(1_000);
  }
  changeCaption(row, replacement);
  if (!settle) {
    first.triggerCaptionMutation(undefined, row);
  }
  const second = await runCaptionRows(
    [row],
    previous,
    settle ? { priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown> } : {},
  );
  expect(second.result).toMatchObject({
    transcriptLines: 2,
    recentTranscript: [{ text: initial }, { text: replacement }],
  });
});

it("retains settled markers for older rows while newer captions settle", async () => {
  const firstRow = captionRow("First settled row", "11");
  const secondRow = captionRow("Second settled row", "12");
  const first = await settledRows([firstRow]);
  const second = await runCaptionRows([firstRow, secondRow], first);
  await vi.advanceTimersByTimeAsync(1_000);
  const third = await runCaptionRows([firstRow, secondRow], second);

  expect(third.result.transcriptLines).toBe(2);
  expect(third.result.recentTranscript).toMatchObject([
    { text: "First settled row" },
    { text: "Second settled row" },
  ]);
});

it("updates a caption when its speaker label arrives late", async () => {
  const row = captionRow("Late attribution", undefined, "");
  const first = await runCaptionRows([row]);
  changeCaption(row, "OpenClaw QA", "author");
  const second = await runCaptionRows([row], first);

  expect(second.result.transcriptLines).toBe(1);
  expect(second.result.recentTranscript).toMatchObject([
    { speaker: "OpenClaw QA", text: "Late attribution" },
  ]);
});

it("disconnects stale caption capture outside transcribe mode", async () => {
  const captions = captionOwner();
  const { window } = await runStatusScript({
    leave: control({ label: "Leave" }),
    priorCaptions: { observer: captions.observer, observerInstalled: true },
  });

  expect(disconnect).toHaveBeenCalledOnce();
  expect(window).not.toHaveProperty(CAPTIONS);
});

it("does not clear captions owned by another tab or meeting session", async () => {
  const { observer, observerInstalled, sessionId } = captionOwner("another-session");
  const active = { observer, observerInstalled, sessionId };
  const wrongTab = await runStatusScript({
    allowSessionAdoption: false,
    currentUrl: "https://teams.live.com/v2/",
    leave: control({ label: "Leave" }),
    priorCaptions: active,
  });
  const wrongSession = await runCaptionStatusScript({
    allowSessionAdoption: false,
    priorCaptions: active,
  });

  expect(disconnect).not.toHaveBeenCalled();
  expect(wrongTab.window[CAPTIONS]).toBe(active);
  expect(wrongSession.window[CAPTIONS]).toBe(active);
});

it.each([false, true])("finalizes captions when identity is lost (SPA=%s)", async (spa) => {
  const currentUrl = spa ? CONSUMER_URL : "https://teams.live.com/v2/";
  const text = spa ? "Last caption before navigation" : "Preserve call-end captions";
  const captions = captionOwner("session-1", { visible: [{ text }] });
  const { window } = spa
    ? await runStatusScript({
        currentUrl,
        priorCaptions: captions,
        priorMeeting: { identity, sessionId: "session-1" },
        readOnly: true,
      })
    : await runCaptionStatusScript({ currentUrl, priorCaptions: captions });
  expect(disconnect).toHaveBeenCalledOnce();
  expect(captions).toMatchObject({ finalized: true, lines: [{ text }] });
  if (spa) {
    expect(window[MEETING_STATE_KEY]).toBeUndefined();
  } else {
    const read = transcriptReader(window, { currentUrl, finalize: true });
    expect(JSON.parse(read())).toMatchObject({ lines: [{ text }] });
    expect(JSON.parse(read())).toMatchObject({ lines: [{ text }] });
    expect(window[CAPTIONS]).toBe(captions);
  }
});

it("finalizes caption capture before an SPA navigation can mix meetings", async () => {
  const params = {
    captionRows: [captionRow("Meeting A caption")],
    captureCaptions: true,
    leave: control({ label: "Leave" }),
  };
  const page = await runStatusScript(params);

  params.captionRows = [captionRow("Meeting B caption")];
  page.triggerCaptionMutation(CONSUMER_URL);

  const captions = page.window[CAPTIONS] as {
    finalized?: boolean;
    lines?: Array<{ text: string }>;
    visible?: Array<{ text: string }>;
  };
  expect(page.captionObserverDisconnects()).toBe(1);
  expect(captions.finalized).toBe(true);
  expect([...(captions.lines ?? []), ...(captions.visible ?? [])]).toMatchObject([
    { text: "Meeting A caption" },
  ]);
});

it("returns finalized captions after the tab navigates into another meeting", () => {
  const window = {
    [CAPTIONS]: {
      droppedLines: 0,
      finalized: true,
      identity,
      lines: [{ text: "Finalized before navigation" }],
      sessionId: "session-1",
      visible: [],
    },
    [MEETING_STATE_KEY]: {
      identity: "teams-consumer:9326458712345:abc",
      sessionId: "session-2",
    },
  };
  const readTranscript = transcriptReader(window, { currentUrl: CONSUMER_URL, finalize: true });

  expect(JSON.parse(readTranscript())).toMatchObject({
    urlMatched: true,
    sessionMatched: true,
    lines: [{ text: "Finalized before navigation" }],
  });
  expect(JSON.parse(readTranscript())).toMatchObject({
    lines: [{ text: "Finalized before navigation" }],
  });
  expect(window[CAPTIONS]).toBeDefined();
});

it("preserves same-session captions during the in-call rerender window", async () => {
  const staleControl = control({ label: "Leave" });
  staleControl.isConnected = false;
  const active = captionOwner("session-1", { enabledAttempted: true });
  const currentUrl = "https://teams.live.com/v2/";
  const { window } = await runStatusScript({
    captureCaptions: true,
    currentUrl,
    priorCaptions: active,
    priorMeeting: rerenderOwner(staleControl, currentUrl),
  });

  expect(disconnect).not.toHaveBeenCalled();
  expect(window[CAPTIONS]).toBe(active);
});

it("keeps the live caption observer during a bounded in-call control rerender", async () => {
  const leave = control({ label: "Leave" });
  const currentUrl = "https://teams.live.com/v2/";
  const page = await runCaptionStatusScript({
    captionRows: [captionRow("Caption before control rerender")],
    currentUrl,
    leave,
    priorMeeting: rerenderOwner(leave, currentUrl),
  });

  leave.isConnected = false;
  page.triggerCaptionMutation();

  expect(page.captionObserverDisconnects()).toBe(0);
  expect(page.window[CAPTIONS]).not.toMatchObject({ finalized: true });
});

it.each(["session-1", ""])(
  "refuses recovery session %j against a committed owner",
  async (meetingSessionId) => {
    const leave = control({ label: "Leave" });
    const priorMeeting = rerenderOwner(leave, URL, "active-session");
    const priorCaptions = captionOwner("active-session", {
      lines: [{ text: "Active session caption" }],
    });

    const { result, window } = await runCaptionStatusScript({
      allowSessionAdoption: false,
      leave,
      meetingSessionId,
      priorCaptions,
      priorMeeting,
    });

    expect(result).toMatchObject({ manualAction: { reason: "teams-session-conflict" } });
    expect(window[MEETING_STATE_KEY]).toBe(priorMeeting);
    expect(window[CAPTIONS]).toBe(priorCaptions);
    expect(disconnect).not.toHaveBeenCalled();
  },
);

it("repairs a stale caption owner for the committed meeting session", async () => {
  const staleCaptions = captionOwner("stale-session", { lines: [{ text: "Stale caption owner" }] });
  const { result, window } = await runCaptionStatusScript({
    allowSessionAdoption: false,
    priorCaptions: staleCaptions,
    priorMeeting: { identity, sessionId: "session-1" },
  });

  expect(result.manualAction).toBeUndefined();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(staleCaptions).toMatchObject({ finalized: true });
  expect(window[CAPTIONS]).toMatchObject({ sessionId: "session-1" });
});

it("disconnects caption capture when finalizing a transcript", async () => {
  vi.useFakeTimers();
  const first = await runCaptionRows([captionRow("Final caption", "17")], undefined, {
    captionsInitiallyOn: true,
  });
  const captions = first.window[CAPTIONS] as Record<string, unknown>;
  expect(captions.settleTimer).toBeDefined();
  captions.observer = { disconnect };
  captions.observerInstalled = true;
  transcriptReader(first.window, { finalize: true })();

  expect(disconnect).toHaveBeenCalledOnce();
  expect(captions).toMatchObject({
    settleTimer: undefined,
    visible: [],
    observerInstalled: false,
    identity,
    finalizedAt: expect.any(Number),
  });

  await vi.advanceTimersByTimeAsync(1_000);
  expect(captions.lines).toMatchObject([{ text: "Final caption" }]);

  const refreshed = await runCaptionRows([captionRow("Late caption")], undefined, {
    priorCaptions: captions,
  });
  expect(refreshed.window[CAPTIONS]).toBe(captions);
  expect(captions.observerInstalled).toBe(false);
  expect(captions.lines).toMatchObject([{ text: "Final caption" }]);
});

it("grants media permissions only to the exact Teams meeting origin", () => {
  const { browser } = TEAMS_MEETINGS_PLATFORM_ADAPTER;
  const permissions = (meetingUrl: string) =>
    browser.permissions({ allowMicrophone: true, meetingUrl });
  expect(permissions(URL)).toEqual({
    origin: "https://teams.microsoft.com",
    permissions: ["audioCapture"],
    optionalPermissions: ["speakerSelection"],
  });
  expect(permissions("https://teams.live.com/meet/123?p=abc")).toMatchObject({
    origin: "https://teams.live.com",
  });
  expect(permissions("https://evil.example/meet/123")).toBeUndefined();
  expect(permissions("https://teams.microsoft.com:8443/l/meetup-join/test")).toBeUndefined();
  expect(permissions("https://teams.live.com:444/meet/123")).toBeUndefined();
  expect(browser.permissionNotes({ allowMicrophone: true })).toContain(
    "Granted Teams microphone permission through browser control.",
  );
});
