import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { teamsMeetingPageScripts } from "./teams-meetings-page-scripts.js";
import { TEAMS_MEETINGS_PLATFORM_ADAPTER } from "./teams-meetings-platform-adapter.js";
import {
  URL,
  CONSUMER_URL,
  MEETING_STATE_KEY,
  MEETING_IDENTITY as identity,
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

function expectRecent(
  page: Awaited<ReturnType<typeof runCaptionRows>>,
  texts: string[],
  extra: Record<string, unknown> = {},
) {
  expect(page.result).toMatchObject({
    transcriptLines: texts.length,
    recentTranscript: texts.map((text) => ({ text })),
    ...extra,
  });
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
  expect(second.result).toMatchObject({
    captioning: true,
    captionsEnabledAttempted: true,
    inCall: true,
  });
  expect(JSON.parse(transcriptReader(second.window)())).toMatchObject({
    droppedLines: 0,
    epoch: "teams-caption-epoch",
    lines: [{ speaker: "OpenClaw QA", text: "Retry captions" }],
    sessionMatched: true,
    urlMatched: true,
  });
  expect(second.window[CAPTIONS]).toMatchObject({ identity });
});

it("bounds visible and committed caption rows together", async () => {
  const { result, window } = await runCaptionStatusScript({
    captionRows: Array.from({ length: 505 }, (_, index) => captionRow(`Bounded caption ${index}`)),
  });
  expect(result.transcriptLines).toBe(505);
  const readTranscript = transcriptReader(window);
  const transcript = JSON.parse(readTranscript()) as { droppedLines: number; lines: unknown[] };
  expect(transcript.lines).toHaveLength(500);
  expect(transcript.droppedLines).toBe(5);
});

it.each(["shortened text", "logical row", "settled logical row", "late speaker"])(
  "corrects one caption after %s",
  async (kind) => {
    const logical = kind.includes("logical");
    const lateSpeaker = kind === "late speaker";
    const id = logical ? "8" : undefined;
    const row = captionRow("Original text", id, lateSpeaker ? "" : "OpenClaw Q");
    const first =
      kind === "logical row" || lateSpeaker
        ? await runCaptionRows([row])
        : await settledRows([row]);
    const text = lateSpeaker ? "Original text" : "Original";
    if (!logical) {
      changeCaption(
        row,
        lateSpeaker ? "OpenClaw QA" : text,
        lateSpeaker ? "author" : "closed-caption-text",
      );
    }
    const second = await runCaptionRows(logical ? [captionRow(text, id)] : [row], first);
    const speaker = logical || lateSpeaker ? "OpenClaw QA" : "OpenClaw Q";
    expectRecent(second, [text], { recentTranscript: [{ text, speaker }] });
  },
);

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
  expectRecent(second, [initial, replacement]);
});

it("retains settled markers for older rows while newer captions settle", async () => {
  const firstRow = captionRow("First settled row", "11");
  const secondRow = captionRow("Second settled row", "12");
  const first = await settledRows([firstRow]);
  const second = await runCaptionRows([firstRow, secondRow], first);
  await vi.advanceTimersByTimeAsync(1_000);
  const third = await runCaptionRows([firstRow, secondRow], second);
  expectRecent(third, ["First settled row", "Second settled row"]);
  const missing = await runCaptionRows([], third);
  const returned = await runCaptionRows([firstRow, secondRow], missing);
  expectRecent(returned, ["First settled row", "Second settled row"]);
});

it.each(["disabled", "foreign tab", "foreign session", "recovery", "ID-less recovery", "repair"])(
  "respects caption ownership during %s",
  async (kind) => {
    const recovery = kind.includes("recovery");
    const repair = kind === "repair";
    const disabled = kind === "disabled";
    const priorCaptions = captionOwner(recovery ? "active-session" : "another-session");
    const leave = control({ label: "Leave" });
    const priorMeeting = recovery
      ? rerenderOwner(leave, URL, "active-session")
      : repair
        ? { identity, sessionId: "session-1" }
        : undefined;
    const { result, window } = await runStatusScript({
      allowSessionAdoption: disabled,
      captureCaptions: !disabled && kind !== "foreign tab",
      currentUrl: kind === "foreign tab" ? "https://teams.live.com/v2/" : URL,
      meetingSessionId: kind === "ID-less recovery" ? "" : "session-1",
      leave,
      priorMeeting,
      priorCaptions: disabled
        ? { observer: { disconnect }, observerInstalled: true }
        : priorCaptions,
    });
    if (disabled) {
      expect(window).not.toHaveProperty(CAPTIONS);
    } else if (repair) {
      expect(result.manualAction).toBeUndefined();
      expect(priorCaptions).toMatchObject({ finalized: true });
      expect(window[CAPTIONS]).toMatchObject({ sessionId: "session-1" });
    } else {
      expect(window[CAPTIONS]).toBe(priorCaptions);
      if (recovery) {
        expect(result).toMatchObject({ manualAction: { reason: "teams-session-conflict" } });
        expect(window[MEETING_STATE_KEY]).toBe(priorMeeting);
      }
    }
    expect(disconnect).toHaveBeenCalledTimes(disabled || repair ? 1 : 0);
  },
);

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

  const captions = page.window[CAPTIONS];
  expect(page.captionObserverDisconnects()).toBe(1);
  expect(captions).toMatchObject({ finalized: true });
  page.window[MEETING_STATE_KEY] = {
    identity: "teams-consumer:9326458712345:abc",
    sessionId: "session-2",
  };
  const readTranscript = transcriptReader(page.window, {
    currentUrl: CONSUMER_URL,
    finalize: true,
  });
  expect(JSON.parse(readTranscript())).toMatchObject({
    urlMatched: true,
    sessionMatched: true,
    lines: [{ text: "Meeting A caption" }],
  });
  expect(JSON.parse(readTranscript())).toMatchObject({ lines: [{ text: "Meeting A caption" }] });
  expect(page.window[CAPTIONS]).toBe(captions);
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
  const refreshed = await runStatusScript({
    captureCaptions: true,
    currentUrl,
    priorCaptions: page.window[CAPTIONS],
    priorMeeting: rerenderOwner(leave, currentUrl),
  });
  expect(page.captionObserverDisconnects()).toBe(0);
  expect(refreshed.window[CAPTIONS]).toBe(page.window[CAPTIONS]);
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
  expect(captions.settleTimer).toBeUndefined();

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
});
