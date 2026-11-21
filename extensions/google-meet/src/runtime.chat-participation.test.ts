import assert from "node:assert/strict";
import type { MeetingParticipationAttempt } from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { useMeetingTestState } from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "./config.js";
import { GoogleMeetRuntime } from "./runtime.js";
import { meetLaunchedTab, MEET_URL } from "./test-support/fixtures.test-helpers.js";
import * as chromeTransport from "./transports/chrome.js";

const state = useMeetingTestState(createOpenClawTestState);

function memoryKeyedStore() {
  const rows = new Map<string, { value: MeetingParticipationAttempt; createdAt: number }>();
  return {
    entries: async () =>
      [...rows].map(([key, row]) => ({ key, value: row.value, createdAt: row.createdAt })),
    delete: async (key: string) => rows.delete(key),
    lookup: async (key: string) => rows.get(key)?.value,
    registerIfAbsent: async (key: string, value: MeetingParticipationAttempt) => {
      if (rows.has(key)) {
        return false;
      }
      rows.set(key, { value, createdAt: Date.now() });
      return true;
    },
    register: async (key: string, value: MeetingParticipationAttempt) => {
      rows.set(key, { value, createdAt: Date.now() });
    },
  };
}

function chatRuntime() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const runtime = new GoogleMeetRuntime({
    config: resolveGoogleMeetConfig({
      defaultTransport: "chrome",
      defaultMode: "transcribe",
      realtime: { introMessage: "" },
    }),
    fullConfig: { transcripts: { enabled: false } },
    runtime: { state: { openKeyedStore: () => memoryKeyedStore() } } as unknown as PluginRuntime,
    logger,
  });
  return state.track(runtime, { readWarnings: () => logger.warn.mock.calls });
}

it("observes in-call chat on transcript capture and sends chat replies", async () => {
  state.onCleanup(async () => {
    vi.restoreAllMocks();
  });
  vi.spyOn(chromeTransport, "launchChromeMeet").mockResolvedValue(meetLaunchedTab("meet-tab"));
  vi.spyOn(chromeTransport, "leaveChromeMeet").mockResolvedValue({ left: true, note: "left" });
  vi.spyOn(chromeTransport, "readChromeMeetTranscript").mockResolvedValue({
    droppedLines: 0,
    lines: [],
  });
  const readChat = vi.spyOn(chromeTransport, "readChromeMeetChat").mockResolvedValue([
    {
      id: "spaces/s/messages/1",
      text: "Bak, can you post the summary?",
      sender: "Luke",
      self: false,
    },
    { id: "spaces/s/messages/2", text: "Sure, one moment.", self: true },
  ]);
  const participate = vi
    .spyOn(chromeTransport, "participateInChromeMeet")
    .mockResolvedValue({ status: "succeeded", observed: { messageId: "spaces/s/messages/3" } });
  const runtime = chatRuntime();

  const { session } = await runtime.join({ url: MEET_URL });
  expect(runtime.participationContext(session.id)).toMatchObject({
    active: true,
    capabilities: ["chat"],
    sources: [],
  });

  await runtime.transcript(session.id);
  expect(readChat).toHaveBeenCalledWith(
    expect.objectContaining({
      meetingUrl: MEET_URL,
      tab: { targetId: "meet-tab", openedByPlugin: true },
    }),
  );
  const context = runtime.participationContext(session.id);
  expect(context.sources).toHaveLength(1);
  const [source] = context.sources;
  assert.ok(source);
  expect(source).toMatchObject({
    kind: "chat",
    text: "Bak, can you post the summary?",
    finalized: true,
    provenance: { observer: "google-meet-chat-dom", speaker: "Luke", self: "other" },
  });

  const rejected = await runtime.participate(session.id, {
    requestId: "req-empty",
    sourceId: source.sourceId,
    action: { type: "chat", text: "  " },
  });
  expect(rejected).toMatchObject({
    status: "rejected",
    message: expect.stringMatching(/non-empty/),
    correctionOf: "req-empty",
  });
  expect(participate).not.toHaveBeenCalled();

  const result = await runtime.participate(session.id, {
    requestId: "req-1",
    sourceId: source.sourceId,
    correctionOf: "req-empty",
    action: { type: "chat", text: "Summary posted below." },
  });
  expect(result).toMatchObject({
    requestId: "req-1",
    status: "succeeded",
    observed: { messageId: "spaces/s/messages/3" },
  });
  expect(participate).toHaveBeenCalledWith(
    expect.objectContaining({
      meetingSessionId: session.id,
      meetingUrl: MEET_URL,
      requestId: "req-1",
      action: { type: "chat", text: "Summary posted below." },
      tab: { targetId: "meet-tab", openedByPlugin: true },
    }),
  );

  await runtime.leave(session.id);
  expect(runtime.participationContext(session.id)).toMatchObject({
    active: false,
    capabilities: [],
  });
});
