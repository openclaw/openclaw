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

function trackedBrowserRuntime(defaultTransport: "chrome" | "chrome-node") {
  state.onCleanup(async () => {
    vi.restoreAllMocks();
  });
  return state.track(
    meetRuntime(
      { defaultTransport, defaultMode: "agent", realtime: { introMessage: "" } },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      { transcripts: { enabled: false } },
    ),
  );
}

it("clears routed audio after a confirmed browser departure", async () => {
  const runtime = trackedBrowserRuntime("chrome");
  const tab = meetLaunchedTab("routed-tab");
  vi.spyOn(chromeTransport, "launchChromeMeet").mockResolvedValue({
    ...tab,
    browser: { ...tab.browser, audioInputRouted: true, audioOutputRouted: true },
  });
  vi.spyOn(chromeTransport, "recoverCurrentMeetTab").mockResolvedValue({
    found: false,
    transport: "chrome",
    message: "Tab closed",
  });
  const leave = vi
    .spyOn(chromeTransport, "leaveChromeMeet")
    .mockResolvedValueOnce({ left: false, note: "Leave unconfirmed" })
    .mockResolvedValue({ left: true, note: "Tab closed" });
  const { session } = await runtime.join({ url: MEET_URL });
  expect(session.chrome?.health?.audioInputRouted).toBe(true);
  await expect(runtime.leave(session.id)).resolves.toMatchObject({
    browserLeft: false,
    session: { chrome: { browserTab: tab.tab, health: { audioInputRouted: true } } },
  });
  await expect(runtime.leave(session.id)).resolves.toMatchObject({ browserLeft: true });
  await expect(runtime.status(session.id)).resolves.toMatchObject({
    session: {
      state: "ended",
      browserLeft: true,
      chrome: {
        browserTab: undefined,
        health: { inCall: false, audioInputRouted: false, audioOutputRouted: false },
      },
    },
  });
  expect(leave).toHaveBeenCalledTimes(2);
});

it("keeps a confirmed departure when an in-flight status finds a replacement tab", async () => {
  const runtime = trackedBrowserRuntime("chrome");
  vi.spyOn(chromeTransport, "launchChromeMeet").mockResolvedValue(meetLaunchedTab("original"));
  vi.spyOn(chromeTransport, "leaveChromeMeet").mockResolvedValue({ left: true, note: "Left call" });
  const started = createDeferred<void>();
  const resume = createDeferred<void>();
  const recover = vi
    .spyOn(chromeTransport, "recoverCurrentMeetTab")
    .mockImplementation(async () => {
      started.resolve();
      await resume.promise;
      return {
        found: true,
        targetId: "replacement",
        browser: { inCall: true, audioInputRouted: true },
        transport: "chrome",
        message: "Active call at the same URL",
      };
    });
  const { session } = await runtime.join({ url: MEET_URL });
  const pending = runtime.status(session.id);
  await Promise.race([started.promise, pending]);
  try {
    await expect(runtime.leave(session.id)).resolves.toMatchObject({ browserLeft: true });
  } finally {
    resume.resolve();
  }
  const ended = {
    id: session.id,
    state: "ended",
    chrome: { browserTab: undefined, health: { inCall: false, audioInputRouted: false } },
  };
  await expect(pending).resolves.toMatchObject({ session: ended });
  await expect(runtime.status(session.id)).resolves.toMatchObject({ session: ended });
  await expect(runtime.status()).resolves.toMatchObject({ sessions: [ended] });
  expect(recover).toHaveBeenCalledOnce();
});

it.each([
  { transport: "chrome-node", nodeId: "node-a", shared: true },
  { transport: "chrome-node", nodeId: "node-b", shared: false },
  { transport: "chrome", nodeId: undefined, shared: false },
] as const)("checks whether the same target on $transport/$nodeId is shared", async (other) => {
  const runtime = trackedBrowserRuntime("chrome-node");
  const tab = meetLaunchedTab("same-target", false);
  const launchOnNode = vi
    .spyOn(chromeTransport, "launchChromeMeetOnNode")
    .mockResolvedValueOnce({ ...tab, nodeId: "node-a" });
  if (other.nodeId) {
    launchOnNode.mockResolvedValueOnce({ ...tab, nodeId: other.nodeId });
  }
  vi.spyOn(chromeTransport, "launchChromeMeet").mockResolvedValue(tab);
  const leave = vi.spyOn(chromeTransport, "leaveChromeMeet").mockResolvedValue({
    left: true,
    note: "Left call",
  });
  const { session } = await runtime.join({ url: MEET_URL });
  const second = await runtime.join({
    transport: other.transport,
    url: "https://meet.google.com/xyz-uvwx-rst",
  });
  const result = await runtime.leave(session.id);
  if (other.shared) {
    expect(result.browserLeft).toBeUndefined();
    expect(leave).not.toHaveBeenCalled();
  } else {
    expect(result.browserLeft).toBe(true);
    expect(leave).toHaveBeenCalledWith(
      expect.objectContaining({ transport: "chrome-node", nodeId: "node-a", tab: tab.tab }),
    );
  }
  await expect(runtime.leave(second.session.id)).resolves.toMatchObject({ browserLeft: true });
  expect(leave.mock.lastCall?.[0].nodeId).toBe(other.nodeId);
  expect(leave.mock.lastCall?.[0].tab).toEqual(tab.tab);
});

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
