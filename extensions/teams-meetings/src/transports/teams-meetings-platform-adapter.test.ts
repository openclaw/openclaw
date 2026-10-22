import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { TEAMS_MEETINGS_PLATFORM_ADAPTER } from "./teams-meetings-platform-adapter.js";
import {
  CONSUMER_URL,
  abortingMedia,
  MEETING_STATE_KEY,
  consumerLightMeetingUrl,
  control,
  liveMediaStream,
  runAudioStatusScript,
  runStatusScript,
  runLeaveScript,
  type PageMedia,
} from "./teams-meetings-platform-adapter.test-helpers.js";

const { browser, urls } = TEAMS_MEETINGS_PLATFORM_ADAPTER;
const identity = "teams-work:19:meeting_test@thread.v2";
const appUrl = "https://teams.microsoft.com/v2/";
const AUDIO_OUTPUTS = "__openclawTeamsAudioOutputs";
const meetingOwner = (overrides: Record<string, unknown> = {}) => ({
  identity,
  sessionId: "session-1",
  ...overrides,
});
const afterCall = (params: Parameters<typeof runLeaveScript>[0]) =>
  runLeaveScript({
    postCall: control({ label: "Rejoin" }),
    priorMeeting: meetingOwner(),
    ...params,
  });
const audioEntry = (source: object, bridge: object, extra: Record<string, unknown>) => ({
  bridge,
  sessionId: "session-1",
  source,
  sourceMuted: false,
  ...extra,
});

function prejoin(overrides: Parameters<typeof runStatusScript>[0] = {}) {
  return {
    camera: control({ label: "Turn camera on", pressed: false }),
    microphone: control({ label: "Turn microphone on", pressed: false }),
    join: control({ label: "Join now" }),
    ...overrides,
  };
}

it.each([true, false])("admits capture only for its session (owner=%s)", async (owns) => {
  const source = browser.buildAudioCaptureScript?.({
    action: "start",
    captureId: "capture-1",
    meetingSessionId: "session-1",
    meetingUrl: CONSUMER_URL,
  });
  const owner = urls.normalizeForReuse(CONSUMER_URL);
  const result = runInNewContext(`(${source})()`, {
    URL,
    location: { href: CONSUMER_URL },
    window: {
      __openclawTeamsMeeting: { sessionId: owns ? "session-1" : "session-2", identity: owner },
    },
    AudioContext: function AudioContext() {
      throw new Error("capture admitted");
    },
  });
  await expect(result).rejects.toThrow(owns ? "capture admitted" : "no longer owns");
});

it("retries transient in-call audio routing while Teams renders its media controls", () => {
  const pending: Parameters<NonNullable<typeof browser.shouldRetryJoinStatus>>[0] = {
    inCall: true,
    manualAction: { reason: "teams-audio-choice-required", message: "manual action" },
  };
  const retry = (overrides: Partial<typeof pending> = {}) =>
    browser.shouldRetryJoinStatus?.({ ...pending, ...overrides });

  expect(retry()).toBe(false);
  expect(retry({ audioInputRouted: true, audioOutputRouteRetryable: true })).toBe(true);
  expect(retry({ audioOutputRouteError: "sink failed" })).toBe(false);
  expect(
    retry({
      audioInputRouted: true,
      audioOutputRouteError: "play interrupted",
      audioOutputRouteRetryable: true,
    }),
  ).toBe(true);
});

it("re-reads camera and microphone state after toggling before joining", async () => {
  const camera = control({
    label: "Turn camera off",
    pressed: true,
    onClick: (node) => node.setPressed(false),
  });
  const microphone = control({
    label: "Turn microphone off",
    pressed: true,
    onClick: (node) => node.setPressed(false),
  });
  const join = control({ label: "Join now" });

  const { result } = await runStatusScript({ camera, join, microphone });

  expect(result).toMatchObject({ cameraOff: true, clickedJoin: true, micMuted: true });
  expect([camera.clicks, microphone.clicks, join.clicks]).toEqual([1, 1, 1]);
});

it("allows non-adopting recovery to continue for the current page owner", async () => {
  const params = prejoin({ allowSessionAdoption: false, priorMeeting: meetingOwner() });
  const { result } = await runStatusScript(params);
  expect(params.join.clicks).toBe(1);
  expect(result.clickedJoin).toBe(true);
  expect(result.manualAction).toBeUndefined();
});

it("preserves a newer owner for a different meeting identity", async () => {
  const priorMeeting = {
    identity: "teams-consumer:9326458712345:p:abc",
    sessionId: "consumer-session",
  };
  const { result, window } = await runStatusScript({
    allowSessionAdoption: true,
    currentUrl: CONSUMER_URL,
    priorMeeting,
  });

  expect(result.manualAction).toMatchObject({ reason: "teams-session-conflict" });
  expect(window[MEETING_STATE_KEY]).toBe(priorMeeting);
});

it("does not auto-join talk-back when the microphone control is missing", async () => {
  const params = prejoin({ allowMicrophone: true, microphone: undefined });
  const { result } = await runStatusScript(params);
  expect(result).toMatchObject({ manualAction: { reason: "teams-microphone-required" } });
  expect(params.join.clicks).toBe(0);
});

it("does not accept a selected BlackHole speaker option as the microphone", async () => {
  const params = prejoin({
    allowMicrophone: true,
    devices: [{ deviceId: "blackhole", kind: "audioinput", label: "BlackHole 2ch" }],
    globalSelectedOption: control({ label: "BlackHole 2ch" }),
    microphoneDevice: control({ label: "MacBook Pro Microphone" }),
  });
  const { result } = await runStatusScript(params);
  expect(result).toMatchObject({
    audioInputRouted: false,
    clickedJoin: false,
    manualAction: { reason: "teams-audio-choice-required" },
    micMuted: true,
  });
  expect(params).toMatchObject({ microphone: { clicks: 0 }, join: { clicks: 0 } });
});

it("does not stamp meeting identity onto unrelated Teams pages", async () => {
  const leave = control({ label: "Leave" });
  const { result, window } = await runStatusScript({ currentUrl: appUrl, leave });

  expect(result.inCall).toBe(false);
  expect(window).not.toHaveProperty("__openclawTeamsMeeting");
});

it.each([
  ["9326458712345", "abc", true],
  ["1111111111111", "other", false],
] as const)("verifies consumer prejoin coordinates %s", async (code, passcode, matches) => {
  const { result, window } = await runStatusScript({
    currentUrl: consumerLightMeetingUrl(code, passcode),
    meetingUrl: CONSUMER_URL,
  });
  if (matches) {
    expect(result.manualAction).toBeUndefined();
    expect(window[MEETING_STATE_KEY]).toMatchObject({
      identity: "teams-consumer:9326458712345:p:abc",
      sessionId: "session-1",
    });
  } else {
    expect(result).toMatchObject({
      inCall: false,
      manualAction: { reason: "teams-session-conflict" },
    });
    expect(window).not.toHaveProperty(MEETING_STATE_KEY);
  }
});

it.each([0, 45_000])("adopts a join marker aged %d ms", async (age) => {
  const prepared = age
    ? meetingOwner({ verifiedAt: Date.now() - age })
    : (await runStatusScript({ allowMicrophone: false })).window[MEETING_STATE_KEY];
  const leave = control({ label: "Leave" });
  const admitted = await runStatusScript({
    currentUrl: appUrl,
    leave,
    priorMeeting: prepared as Record<string, unknown>,
    waitForInCallMs: 60_000,
  });
  expect(admitted.result.inCall).toBe(true);
  expect(admitted.window[MEETING_STATE_KEY]).toMatchObject({
    identity,
    inCallControl: leave,
    inCallUrl: appUrl,
  });
});

it("re-adopts a replaced hang-up control only within the bounded rerender window", async () => {
  const previousLeave = control({ label: "Leave" });
  previousLeave.isConnected = false;
  const currentLeave = control({ label: "Leave" });
  const { result, window } = await runStatusScript({
    currentUrl: appUrl,
    leave: currentLeave,
    priorMeeting: {
      identity,
      inCallControl: previousLeave,
      inCallUrl: appUrl,
      verifiedAt: Date.now(),
    },
  });

  expect(result.inCall).toBe(true);
  expect(window[MEETING_STATE_KEY]).toMatchObject({
    inCallControl: currentLeave,
    inCallUrl: appUrl,
  });
});

it("does not trust a stale identity marker or post-call screen from another SPA call", () => {
  const staleLeave = control({ label: "Leave old call" });
  const currentLeave = control({ label: "Leave current call" });
  const bridge = { pause: vi.fn(), remove: vi.fn(), srcObject: {} };
  const { result, window } = runLeaveScript({
    currentUrl: appUrl,
    leave: currentLeave,
    postCall: control({ label: "Rejoin" }),
    priorAudioOutputs: [
      { bridge, sessionId: "session-1", source: { muted: true }, sourceMuted: false },
    ],
    priorMeeting: {
      identity,
      inCallControl: staleLeave,
      inCallUrl: appUrl,
    },
  });

  expect(result).toEqual({ departed: false, urlMatched: false });
  expect(currentLeave.clicks).toBe(0);
  expect(bridge.pause).not.toHaveBeenCalled();
  expect(window[AUDIO_OUTPUTS]).toHaveLength(1);
});

it.each([
  ["newer owner", "session-1", "session-2", true, 0],
  ["missing owner", "session-1", "", false, 0],
  ["ID-less callback", "", "session-1", false, 1],
] as const)("checks leave ownership: %s", (_name, meetingSessionId, owner, spa, clicks) => {
  const leave = control({ label: "Leave" });
  const { result } = runLeaveScript({
    leave,
    meetingSessionId,
    ...(spa ? { currentUrl: appUrl } : {}),
    priorMeeting: meetingOwner({
      sessionId: owner,
      ...(spa ? { inCallControl: leave, inCallUrl: appUrl } : {}),
    }),
  });
  const expected = clicks
    ? { leaveAction: "leave" }
    : { sessionMatched: false, ...(spa ? { sessionConflict: true } : {}) };
  expect(result).toEqual({ departed: false, urlMatched: true, ...expected });
  expect(leave.clicks).toBe(clicks);
});

it("accepts post-call proof after an initiated leave replaces the document", () => {
  const pending = runLeaveScript({
    currentUrl: appUrl,
    leaveInitiated: true,
    omitMeetingState: true,
  });
  expect(pending.result).toEqual({ departed: false, urlMatched: true });

  const { result } = runLeaveScript({
    leaveInitiated: true,
    omitMeetingState: true,
    postCall: control({ label: "Rejoin" }),
  });

  expect(result).toEqual({ departed: true, sessionMatched: true, urlMatched: true });
});

it("retires only the departing session's audio bridges", () => {
  const source = { currentSrc: "blob:https://teams.live.com/original", muted: true };
  const bridge = { pause: vi.fn(), remove: vi.fn(), srcObject: {} };
  const detachedSource = {
    isConnected: false,
    muted: true,
    pause: vi.fn(),
    srcObject: liveMediaStream(),
  };
  const detachedBridge = { pause: vi.fn(), remove: vi.fn(), srcObject: {} };
  const foreignBridge = { sessionId: "session-2" };
  const { result, window } = afterCall({
    priorAudioOutputs: [
      audioEntry(source, bridge, { sourceUrl: source.currentSrc }),
      audioEntry(detachedSource, detachedBridge, { stream: detachedSource.srcObject }),
      foreignBridge,
    ],
  });

  expect(result).toEqual({ departed: true, sessionMatched: true, urlMatched: true });
  expect(source.muted).toBe(false);
  expect(bridge.pause).toHaveBeenCalledOnce();
  expect(bridge.remove).toHaveBeenCalledOnce();
  expect(bridge.srcObject).toBeNull();
  expect(detachedSource.muted).toBe(true);
  expect(detachedSource.pause).toHaveBeenCalledOnce();
  expect(detachedSource.srcObject).toBeNull();
  expect(detachedBridge.remove).toHaveBeenCalledOnce();
  expect(window[AUDIO_OUTPUTS]).toEqual([foreignBridge]);
});

it.each(["stream", "url"] as const)("keeps reused %s sources muted on leave", (kind) => {
  const bridgedStream = liveMediaStream();
  const replacementStream = liveMediaStream();
  const source =
    kind === "stream"
      ? { muted: true, srcObject: replacementStream }
      : { muted: true, currentSrc: "blob:https://teams.live.com/replacement" };
  const bridge = {
    pause: vi.fn(),
    remove: vi.fn(),
    srcObject: kind === "stream" ? bridgedStream : null,
  };
  const ownership =
    kind === "stream"
      ? { stream: bridgedStream }
      : { sourceUrl: "blob:https://teams.live.com/original" };
  const { result } = afterCall({ priorAudioOutputs: [audioEntry(source, bridge, ownership)] });
  expect(result).toEqual({ departed: true, sessionMatched: true, urlMatched: true });
  expect(source.muted).toBe(true);
  if (kind === "stream") {
    expect(source.srcObject).toBe(replacementStream);
  }
  expect(bridge.pause).toHaveBeenCalledOnce();
  expect(bridge.remove).toHaveBeenCalledOnce();
});

it("restores pending and legacy sources-array entries during leave cleanup", () => {
  const pending = { muted: true };
  const legacy = { currentSrc: "blob:https://teams.live.com/legacy", muted: true };
  const { result } = afterCall({
    priorAudioOutputs: [
      {
        sessionId: "session-1",
        sources: [
          { element: pending, muted: false, pending: true },
          { element: legacy, muted: false },
        ],
      },
    ],
  });

  expect(result).toEqual({ departed: true, sessionMatched: true, urlMatched: true });
  expect(pending.muted).toBe(true);
  expect(legacy.muted).toBe(true);
});

it("retires the page-owned audio bridge from the required URL-only leave callback", () => {
  const stream = liveMediaStream();
  const source = { muted: true, srcObject: stream };
  const bridge = { pause: vi.fn(), remove: vi.fn(), srcObject: stream };
  const { result, window } = afterCall({
    meetingSessionId: "",
    priorAudioOutputs: [audioEntry(source, bridge, { stream })],
  });

  expect(result).toEqual({ departed: true, sessionMatched: true, urlMatched: true });
  expect(source.muted).toBe(false);
  expect(bridge.pause).toHaveBeenCalledOnce();
  expect(bridge.remove).toHaveBeenCalledOnce();
  expect(window).not.toHaveProperty(AUDIO_OUTPUTS);
});

it("ignores participant-controlled in-call text", async () => {
  const bodyText =
    "Alice: meeting ended — rejoin after lunch; allow Teams to use your microphone; device permissions are blocked";
  const leave = control({ label: "Leave" });
  const { result } = await runStatusScript({ bodyText, leave });

  expect(result.inCall).toBe(true);
  expect(result.manualAction).toBeUndefined();
});

it("does not report a prompt that it just dismissed while Teams removes the DOM", async () => {
  const continueWithoutDevices = control({ label: "Continue without audio or video" });
  const { result } = await runStatusScript({
    continueWithoutDevices,
    permissionPrompt: control({ label: "Device permission prompt" }),
  });

  expect(result.manualAction).toBeUndefined();
  expect(continueWithoutDevices.clicks).toBe(1);
});

it("does not treat the camera-only no-devices warning as a microphone block", async () => {
  const join = control({ label: "Join now" });
  const { result } = await runStatusScript({
    allowMicrophone: true,
    camera: control({ checked: false, label: "Camera" }),
    continueWithoutDevices: control({ label: "Continue without audio or video" }),
    devices: [{ deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" }],
    join,
    microphone: control({ checked: true, label: "Microphone" }),
    microphoneDevice: control({ label: "BlackHole 2ch (Virtual)" }),
    microphonePermissionState: "granted",
    permissionPrompt: control({ label: "Camera permission warning" }),
  });

  expect(result.clickedJoin).toBe(true);
  expect(result.manualAction).toBeUndefined();
  expect(join.clicks).toBe(1);
});

it("does not infer departure from page-wide text", () => {
  const { result } = runLeaveScript({ bodyText: "call ended — rejoin" });
  expect(result).toEqual({ departed: false, urlMatched: true });
});

it("rejects a non-contract virtual audio label", async () => {
  const deviceLabel = "OpenClaw Meeting Audio (Virtual)";
  const { result } = await runStatusScript(
    prejoin({
      allowMicrophone: true,
      devices: [{ deviceId: "virtual-input", kind: "audioinput", label: deviceLabel }],
      microphoneDevice: control({ label: deviceLabel }),
    }),
  );

  expect(result).toMatchObject({
    audioInputRouted: false,
    manualAction: {
      message:
        "Select the OpenClaw virtual audio device as the Teams microphone and verify it is selected before enabling talk-back.",
      reason: "teams-audio-choice-required",
    },
  });
});

it.each(["display", "listbox"] as const)("reverifies microphone via %s", async (kind) => {
  const deviceSettings = control({ label: "Open audio options" });
  const selected = control({ label: "BlackHole 2ch (Virtual)" });
  if (kind === "listbox") {
    selected.getAttribute = (name) =>
      name === "aria-selected" ? "true" : name === "aria-label" ? "BlackHole 2ch (Virtual)" : null;
  }
  const menu = control({ label: "Microphone devices" });
  menu.querySelector = (selector) =>
    selector?.includes('aria-selected="true"') ? selected : undefined;
  const { result } = await runStatusScript({
    allowMicrophone: true,
    devices: [{ deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" }],
    deviceSettings,
    leave: control({ label: "Leave" }),
    microphone: control({ label: "Turn microphone off", pressed: true }),
    ...(kind === "display"
      ? { microphoneDeviceAfterSettings: selected }
      : { microphoneDeviceMenuAfterSettings: menu }),
    priorMeeting: {
      identity,
      ...(kind === "display" ? { audioInputDeviceId: "blackhole-input" } : {}),
    },
  });
  expect(result).toMatchObject({ audioInputRouted: true, inCall: true, micMuted: false });
  expect(deviceSettings.clicks).toBe(1);
});

it("does not choose the audio-less fallback in talkback modes", async () => {
  const continueWithoutDevices = control({ label: "Continue without audio or video" });
  const params = () => ({
    continueWithoutDevices,
    microphone: control({ label: "Turn microphone on", pressed: false }),
  });
  await runStatusScript({ ...params(), allowMicrophone: true });
  expect(continueWithoutDevices.clicks).toBe(0);
  await runStatusScript(params());
  expect(continueWithoutDevices.clicks).toBe(1);
  await runStatusScript({ ...params(), autoJoin: false });
  expect(continueWithoutDevices.clicks).toBe(1);
});

it("bridges a live Teams MediaStream when its unloaded audio element rejects setSinkId", async () => {
  const source = abortingMedia("The element has no supported source.", {
    muted: false,
    sinkId: "built-in-output",
    srcObject: liveMediaStream(),
  });
  const routingOrder: string[] = [];
  const bridge: PageMedia = {
    isConnected: false,
    sinkId: "",
    async play() {
      expect(source.muted).toBe(true);
      expect(bridge.sinkId).toBe("blackhole-output");
      routingOrder.push("play");
    },
    async setSinkId(value) {
      expect(source.muted).toBe(true);
      routingOrder.push("sink");
      bridge.sinkId = value;
    },
  };
  const { result, window } = await runAudioStatusScript({
    bridgeMedia: bridge,
    media: [source],
    priorMeeting: { audioInputDeviceId: "blackhole-input", identity },
  });

  expect(routingOrder).toEqual(["sink", "play"]);
  expect(result).toMatchObject({ audioInputRouted: true, audioOutputRouted: true });
  expect(result.manualAction).toBeUndefined();
  expect(bridge).toMatchObject({ autoplay: false, sinkId: "blackhole-output" });
  expect(source.muted).toBe(true);
  expect(window).toHaveProperty(AUDIO_OUTPUTS);
  expect((window[AUDIO_OUTPUTS] as Array<{ bridge: PageMedia }>)[0]?.bridge).toBe(bridge);

  const repeated = await runAudioStatusScript({
    bridgeMedia: bridge,
    media: [source, bridge],
    priorAudioOutputs: window[AUDIO_OUTPUTS] as unknown[],
    priorMeeting: window[MEETING_STATE_KEY] as Record<string, unknown>,
  });
  expect(repeated.result.audioOutputRouted).toBe(true);
  expect((repeated.window[AUDIO_OUTPUTS] as Array<{ bridge: PageMedia }>)[0]?.bridge).toBe(bridge);
});
