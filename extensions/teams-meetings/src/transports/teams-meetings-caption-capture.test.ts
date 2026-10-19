import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { teamsMeetingPageScripts } from "./teams-meetings-page-scripts.js";
import { TEAMS_MEETINGS_PLATFORM_ADAPTER } from "./teams-meetings-platform-adapter.js";
import {
  URL,
  CONSUMER_URL,
  MEETING_STATE_KEY,
  control,
  captionRow,
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

function captionOwner(sessionId = "session-1", overrides: Record<string, unknown> = {}) {
  return {
    droppedLines: 0,
    lines: [],
    visible: [],
    sessionId,
    observer: { disconnect: vi.fn() },
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

async function settledRow(text: string, id: string) {
  vi.useFakeTimers();
  const first = await runCaptionRows([captionRow("OpenClaw QA", text, id)], undefined, {
    captionsInitiallyOn: true,
  });
  await vi.advanceTimersByTimeAsync(1_000);
  return first;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Microsoft Teams meeting captions and permissions", () => {
  it("enables live captions and captures the validated Teams caption row DOM", async () => {
    const { result, window } = await runCaptionRows([captionRow("OpenClaw QA", "I")]);

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
    expect(window["__openclawTeamsCaptions"]).toMatchObject({
      identity: "teams-work:19:meeting_test@thread.v2",
    });
  });

  it("retries an unverified live-caption activation", async () => {
    const first = await runCaptionRows([captionRow("OpenClaw QA", "Retry captions")], undefined, {
      captionClickIgnored: true,
      captionsInitiallyOn: false,
    });
    expect(first.captionButton.clicks).toBe(1);
    expect(first.result).toMatchObject({
      captioning: false,
      captionsEnabledAttempted: false,
    });

    const second = await runCaptionRows([captionRow("OpenClaw QA", "Retry captions")], first, {
      captionsInitiallyOn: false,
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(second.captionButton.clicks).toBe(1);
    expect(second.result).toMatchObject({
      captioning: true,
      captionsEnabledAttempted: true,
    });
  });

  it("bounds visible and committed caption rows together", async () => {
    const { result, window } = await runCaptionStatusScript({
      captionRows: Array.from({ length: 505 }, (_, index) =>
        captionRow("OpenClaw QA", `Bounded caption ${index}`),
      ),
    });
    const state = window["__openclawTeamsCaptions"] as {
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
    vi.useFakeTimers();
    const row = captionRow("OpenClaw QA", "We should leave today");
    const first = await runCaptionRows([row], undefined, {
      captionsInitiallyOn: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    changeCaption(row, "We should leave");
    const second = await runCaptionRows([row], first);

    expect(second.result).toMatchObject({
      lastCaptionText: "We should leave",
      transcriptLines: 1,
      recentTranscript: [{ speaker: "OpenClaw QA", text: "We should leave" }],
    });
  });

  it("keeps one utterance when Teams replaces a logically identical caption row", async () => {
    const first = await runCaptionRows([captionRow("OpenClaw Q", "Logical row", "8")]);
    const second = await runCaptionRows(
      [captionRow("OpenClaw QA", "Logical row replacement", "8")],
      first,
    );

    expect(second.result).toMatchObject({
      transcriptLines: 1,
      lastCaptionText: "Logical row replacement",
      lastCaptionSpeaker: "OpenClaw QA",
    });
  });

  it("updates a settled logical row in place when Teams corrects it late", async () => {
    const first = await settledRow("Late logical", "9");
    const second = await runCaptionRows(
      [captionRow("OpenClaw QA", "Late logical correction", "9")],
      first,
    );

    expect(second.result.transcriptLines).toBe(1);
    expect(second.result.recentTranscript).toMatchObject([{ text: "Late logical correction" }]);
  });

  it("deduplicates a settled logical row after temporary DOM removal", async () => {
    const first = await settledRow("Virtual row return", "13");
    const missing = await runCaptionRows([], first);
    const returned = await runCaptionRows(
      [captionRow("OpenClaw QA", "Virtual row return", "13")],
      missing,
    );

    expect(returned.result.transcriptLines).toBe(1);
    expect(returned.result.recentTranscript).toMatchObject([{ text: "Virtual row return" }]);
  });

  it("commits an utterance when Teams recycles the same virtual-list row", async () => {
    vi.useFakeTimers();
    const row = captionRow("OpenClaw QA", "First recycled-row utterance");
    const first = await runCaptionRows([row], undefined, {
      captionsInitiallyOn: true,
    });
    const disappeared = await runCaptionRows([], first);
    await vi.advanceTimersByTimeAsync(1_000);
    changeCaption(row, "First recycled-row utterance continued");
    const second = await runCaptionRows([row], disappeared, {
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });

    expect(second.result.transcriptLines).toBe(2);
    expect(second.result.recentTranscript).toMatchObject([
      { text: "First recycled-row utterance" },
      { text: "First recycled-row utterance continued" },
    ]);
  });

  it("commits a removed row before Teams rapidly reuses its DOM node", async () => {
    const row = captionRow("OpenClaw QA", "Rapid first utterance");
    const first = await runCaptionRows([row]);
    changeCaption(row, "Rapid second utterance");
    first.triggerCaptionMutation(undefined, row);
    const second = await runCaptionRows([row], first);

    expect(second.result.transcriptLines).toBe(2);
    expect(second.result.recentTranscript).toMatchObject([
      { text: "Rapid first utterance" },
      { text: "Rapid second utterance" },
    ]);
  });

  it("retains settled markers for older rows while newer captions settle", async () => {
    vi.useFakeTimers();
    const firstRow = captionRow("OpenClaw QA", "First settled row", "11");
    const secondRow = captionRow("OpenClaw QA", "Second settled row", "12");
    const first = await runCaptionRows([firstRow], undefined, {
      captionsInitiallyOn: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
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
    const row = captionRow("", "Late attribution");
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

    expect(captions.observer.disconnect).toHaveBeenCalledOnce();
    expect(window).not.toHaveProperty("__openclawTeamsCaptions");
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

    expect(observer.disconnect).not.toHaveBeenCalled();
    expect(wrongTab.window["__openclawTeamsCaptions"]).toBe(active);
    expect(wrongSession.window["__openclawTeamsCaptions"]).toBe(active);
  });

  it("finalizes requested-session capture after a confirmed SPA meeting transition", async () => {
    const captions = captionOwner("session-1", {
      visible: [{ text: "Last caption before navigation" }],
    });
    const { window } = await runStatusScript({
      currentUrl: CONSUMER_URL,
      priorCaptions: captions,
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "session-1",
      },
      readOnly: true,
    });

    expect(captions.observer.disconnect).toHaveBeenCalledOnce();
    expect(captions).toMatchObject({
      finalized: true,
      lines: [{ text: "Last caption before navigation" }],
    });
    expect(window[MEETING_STATE_KEY]).toBeUndefined();
  });

  it("finalizes same-session captions when meeting identity is lost", async () => {
    const currentUrl = "https://teams.live.com/v2/";
    const priorCaptions = captionOwner("session-1", {
      epoch: "caption-epoch",
      visible: [
        {
          at: "2026-07-17T12:00:00.000Z",
          speaker: "OpenClaw QA",
          text: "Preserve call-end captions",
        },
      ],
    });
    const { window } = await runCaptionStatusScript({
      currentUrl,
      priorCaptions,
    });
    const captions = window["__openclawTeamsCaptions"] as Record<string, unknown>;
    const readTranscript = transcriptReader(window, { currentUrl, finalize: true });
    const transcript = JSON.parse(readTranscript()) as { lines: Array<{ text: string }> };

    expect(priorCaptions.observer.disconnect).toHaveBeenCalledOnce();
    expect(captions.finalized).toBe(true);
    expect(transcript.lines).toMatchObject([{ text: "Preserve call-end captions" }]);
    expect(JSON.parse(readTranscript())).toMatchObject({
      lines: [{ text: "Preserve call-end captions" }],
    });
    expect(window["__openclawTeamsCaptions"]).toBe(captions);
  });

  it("finalizes caption capture before an SPA navigation can mix meetings", async () => {
    const params = {
      captionRows: [captionRow("OpenClaw QA", "Meeting A caption")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    };
    const page = await runStatusScript(params);

    params.captionRows = [captionRow("OpenClaw QA", "Meeting B caption")];
    page.triggerCaptionMutation(CONSUMER_URL);

    const captions = page.window["__openclawTeamsCaptions"] as {
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
      __openclawTeamsCaptions: {
        droppedLines: 0,
        finalized: true,
        identity: "teams-work:19:meeting_test@thread.v2",
        lines: [{ text: "Finalized before navigation" }],
        sessionId: "session-1",
        visible: [],
      },
      __openclawTeamsMeeting: {
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
    expect(window["__openclawTeamsCaptions"]).toBeDefined();
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
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        inCallControl: staleControl,
        inCallUrl: currentUrl,
        sessionId: "session-1",
        verifiedAt: Date.now(),
      },
    });

    expect(active.observer.disconnect).not.toHaveBeenCalled();
    expect(window["__openclawTeamsCaptions"]).toBe(active);
  });

  it("keeps the live caption observer during a bounded in-call control rerender", async () => {
    const leave = control({ label: "Leave" });
    const currentUrl = "https://teams.live.com/v2/";
    const page = await runCaptionStatusScript({
      captionRows: [captionRow("OpenClaw QA", "Caption before control rerender")],
      currentUrl,
      leave,
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        inCallControl: leave,
        inCallUrl: currentUrl,
        sessionId: "session-1",
        verifiedAt: Date.now(),
      },
    });

    leave.isConnected = false;
    page.triggerCaptionMutation();

    expect(page.captionObserverDisconnects()).toBe(0);
    expect(page.window["__openclawTeamsCaptions"]).not.toMatchObject({ finalized: true });
  });

  it.each(["session-1", ""])(
    "refuses recovery session %j against a committed owner",
    async (meetingSessionId) => {
      const leave = control({ label: "Leave" });
      const priorMeeting = {
        identity: "teams-work:19:meeting_test@thread.v2",
        inCallControl: leave,
        inCallUrl: URL,
        sessionId: "active-session",
        verifiedAt: Date.now(),
      };
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

      expect(result).toMatchObject({
        manualAction: { reason: "teams-session-conflict" },
      });
      expect(window[MEETING_STATE_KEY]).toBe(priorMeeting);
      expect(window["__openclawTeamsCaptions"]).toBe(priorCaptions);
      expect(priorCaptions.observer.disconnect).not.toHaveBeenCalled();
    },
  );

  it("repairs a stale caption owner for the committed meeting session", async () => {
    const staleCaptions = captionOwner("stale-session", {
      lines: [{ text: "Stale caption owner" }],
    });
    const { result, window } = await runCaptionStatusScript({
      allowSessionAdoption: false,
      priorCaptions: staleCaptions,
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "session-1",
      },
    });

    expect(result.manualAction).toBeUndefined();
    expect(staleCaptions.observer.disconnect).toHaveBeenCalledOnce();
    expect(staleCaptions).toMatchObject({ finalized: true });
    expect(window["__openclawTeamsCaptions"]).toMatchObject({ sessionId: "session-1" });
  });

  it("disconnects caption capture when finalizing a transcript", async () => {
    const first = await runCaptionRows([captionRow("OpenClaw QA", "Final caption")]);
    let disconnects = 0;
    const captions = first.window["__openclawTeamsCaptions"] as Record<string, unknown>;
    captions.observer = { disconnect: () => (disconnects += 1) };
    captions.observerInstalled = true;
    const finalize = transcriptReader(first.window, { finalize: true });
    finalize();

    expect(disconnects).toBe(1);
    expect(captions.observerInstalled).toBe(false);
    expect(captions.identity).toBe("teams-work:19:meeting_test@thread.v2");
    expect(typeof captions.finalizedAt).toBe("number");

    const refreshed = await runCaptionRows([captionRow("OpenClaw QA", "Late caption")], undefined, {
      priorCaptions: captions,
    });
    expect(refreshed.window["__openclawTeamsCaptions"]).toBe(captions);
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
});
