import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useMeetingTestState } from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import {
  meetAudioBridge,
  meetLaunchedTab,
  meetRuntime,
  MEET_URL,
} from "./test-support/fixtures.test-helpers.js";
import * as chromeTransport from "./transports/chrome.js";

const state = useMeetingTestState(createOpenClawTestState);

it("does not close an adopted tab when the failed session retries leave", async () => {
  state.onCleanup(async () => {
    vi.restoreAllMocks();
  });
  const adoptionStarted = createDeferred<void>();
  const adoption = createDeferred<Awaited<ReturnType<typeof chromeTransport.launchChromeMeet>>>();
  let donorAttempts = 0;
  let allowAdoptedLeave = false;
  vi.spyOn(chromeTransport, "launchChromeMeet")
    .mockResolvedValueOnce(meetLaunchedTab("donor-tab"))
    .mockResolvedValueOnce(meetLaunchedTab("adopted-tab"))
    .mockImplementationOnce(async () => {
      adoptionStarted.resolve();
      return await adoption.promise;
    });
  const leave = vi.spyOn(chromeTransport, "leaveChromeMeet").mockImplementation(async ({ tab }) => {
    const left = tab.targetId === "donor-tab" ? ++donorAttempts > 1 : allowAdoptedLeave;
    return { left, note: left ? "left" : "browser leave failed" };
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const runtime = state.track(
    meetRuntime(
      { defaultTransport: "chrome", defaultMode: "agent", realtime: { introMessage: "" } },
      logger,
      { transcripts: { enabled: false } },
    ),
    { readWarnings: () => logger.warn.mock.calls },
  );
  let replacing: ReturnType<typeof runtime.join> | undefined;
  let retrying: ReturnType<typeof runtime.leave> | undefined;
  const adoptedResult = meetLaunchedTab("adopted-tab", false);
  try {
    await runtime.join({ url: MEET_URL, agentId: "donor" });
    await expect(runtime.join({ url: MEET_URL, agentId: "failed" })).rejects.toThrow(
      "Could not leave the previous Meet browser tab before reassignment.",
    );
    const failed = runtime.list().find((session) => session.agentId === "failed");
    assert.ok(failed, "Expected a retained failed session");
    expect(failed.state).toBe("ended");
    expect(failed.chrome?.browserTab?.targetId).toBe("adopted-tab");
    replacing = runtime.join({ url: MEET_URL, agentId: "replacement" });
    await Promise.race([adoptionStarted.promise, replacing]);
    const callsBeforeRetry = leave.mock.calls.length;
    retrying = runtime.leave(failed.id);
    adoption.resolve(adoptedResult);
    const [replacement] = await Promise.all([replacing, retrying]);
    expect(replacement.session.chrome?.browserTab).toEqual({
      targetId: "adopted-tab",
      openedByPlugin: true,
    });
    expect(leave).toHaveBeenCalledTimes(callsBeforeRetry);
    expect(runtime.list().some((session) => session.id === failed.id)).toBe(false);
    allowAdoptedLeave = true;
    await runtime.leave(replacement.session.id);
    expect(leave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        meetingSessionId: replacement.session.id,
        tab: { targetId: "adopted-tab", openedByPlugin: true },
      }),
    );
  } finally {
    adoption.resolve(adoptedResult);
    await Promise.allSettled([replacing, retrying]);
    allowAdoptedLeave = true;
  }
});

it("keeps the original requester when a reused meeting starts audio after admission", async () => {
  state.onCleanup(async () => {
    vi.restoreAllMocks();
  });
  const ready = { inCall: true, micMuted: false, audioInputRouted: true, audioOutputRouted: true };
  const bridge = meetAudioBridge();
  const launch = vi
    .spyOn(chromeTransport, "launchChromeMeet")
    .mockResolvedValueOnce({ ...meetLaunchedTab("meet-tab"), browser: { inCall: false } })
    .mockResolvedValueOnce({ ...meetLaunchedTab("meet-tab"), browser: ready, audioBridge: bridge });
  vi.spyOn(chromeTransport, "recoverCurrentMeetTab").mockResolvedValue({
    found: true,
    targetId: "meet-tab",
    browser: ready,
    transport: "chrome",
    message: "Ready",
  });
  vi.spyOn(chromeTransport, "leaveChromeMeet").mockResolvedValue({ left: true, note: "left" });
  const runtime = state.track(
    meetRuntime(
      { defaultTransport: "chrome", defaultMode: "agent", realtime: { introMessage: "" } },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      { transcripts: { enabled: false } },
    ),
  );
  const firstKey = "agent:main:session:first";
  const first = await runtime.join({ url: MEET_URL, requesterSessionKey: firstKey });
  const second = await runtime.join({
    url: MEET_URL,
    requesterSessionKey: "agent:main:session:later",
  });
  expect(second.session.id).toBe(first.session.id);
  expect(JSON.stringify(await runtime.status(first.session.id))).not.toContain(firstKey);
  expect((await runtime.speak(first.session.id, "hello")).spoken).toBe(true);
  expect(launch).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ requesterSessionKey: firstKey }),
  );
  expect(bridge.speak).toHaveBeenCalledWith("hello");
});
