import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { TEAMS_MEETINGS_PLATFORM_ADAPTER } from "./teams-meetings-platform-adapter.js";
import {
  CONSUMER_URL,
  abortingMedia,
  audioEntry,
  audioStatusParams,
  AUDIO_OUTPUTS,
  blackholeDevice,
  MEETING_STATE_KEY,
  MEETING_IDENTITY as identity,
  meetingOwner,
  consumerLightMeetingUrl,
  continueStatusScript,
  control,
  liveMediaStream,
  pageMedia,
  runAudioStatusScript,
  runStatusScript,
  runLeaveScript,
  toggleOff,
  type PageMedia,
} from "./teams-meetings-platform-adapter.test-helpers.js";

const { browser, urls } = TEAMS_MEETINGS_PLATFORM_ADAPTER;
const appUrl = "https://teams.microsoft.com/v2/";
const afterCall = (params: Parameters<typeof runLeaveScript>[0]) =>
  runLeaveScript({
    postCall: control({ label: "Rejoin" }),
    priorMeeting: meetingOwner(),
    ...params,
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
  const camera = toggleOff("camera");
  const microphone = toggleOff("microphone");
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

it.each(["missing control", "speaker selection", "unsupported device"])(
  "blocks talk-back for %s",
  async (kind) => {
    const missing = kind === "missing control";
    const speaker = kind === "speaker selection";
    const label = speaker ? "BlackHole 2ch" : "OpenClaw Meeting Audio (Virtual)";
    const params = prejoin({
      allowMicrophone: true,
      microphone: missing ? undefined : control({ label: "Turn microphone on", pressed: false }),
      devices: missing ? [] : [{ deviceId: "input", kind: "audioinput", label }],
      globalSelectedOption: speaker ? control({ label }) : undefined,
      microphoneDevice: missing
        ? undefined
        : control({ label: speaker ? "MacBook Pro Microphone" : label }),
    });
    const { result } = await runStatusScript(params);
    expect(result).toMatchObject({
      manualAction: {
        reason: missing ? "teams-microphone-required" : "teams-audio-choice-required",
      },
      ...(missing ? {} : { audioInputRouted: false }),
      ...(speaker ? { clickedJoin: false, micMuted: true } : {}),
    });
    expect(params.join.clicks).toBe(0);
    if (speaker) {
      expect(params.microphone?.clicks).toBe(0);
    }
  },
);

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
    priorAudioOutputs: [audioEntry({ muted: true }, bridge)],
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

it.each([
  "url",
  "URL-only callback",
  "reused stream",
  "reused url",
  "detached",
  "pending",
  "legacy",
])("cleans up only owned playback on leave: %s", (kind) => {
  const stream = liveMediaStream();
  const replacement = liveMediaStream();
  const streaming = ["URL-only callback", "reused stream", "detached"].includes(kind);
  const reused = kind.startsWith("reused");
  const legacy = kind === "legacy" || kind === "pending";
  const pause = vi.fn();
  const source = {
    muted: true,
    ...(streaming ? { srcObject: reused ? replacement : stream } : {}),
    ...(!streaming && kind !== "pending"
      ? { currentSrc: reused ? "replacement" : "original" }
      : {}),
    ...(kind === "detached" ? { isConnected: false, pause } : {}),
  };
  const bridge = { pause: vi.fn(), remove: vi.fn(), srcObject: stream };
  const foreign = { sessionId: "session-2" };
  const entry = legacy
    ? {
        sessionId: "session-1",
        sources: [
          { element: source, muted: false, ...(kind === "pending" ? { pending: true } : {}) },
        ],
      }
    : audioEntry(source, bridge, streaming ? { stream } : { sourceUrl: "original" });
  const { result, window } = afterCall({
    meetingSessionId: kind === "URL-only callback" ? "" : "session-1",
    priorAudioOutputs: kind === "url" ? [entry, foreign] : [entry],
  });
  expect(result).toEqual({ departed: true, sessionMatched: true, urlMatched: true });
  expect(source.muted).toBe(reused || legacy || kind === "detached");
  if (kind === "url") {
    expect(window[AUDIO_OUTPUTS]).toEqual([foreign]);
  } else {
    expect(window).not.toHaveProperty(AUDIO_OUTPUTS);
  }
  if (!legacy) {
    expect(bridge.pause).toHaveBeenCalledOnce();
    expect(bridge.remove).toHaveBeenCalledOnce();
    expect(bridge.srcObject).toBeNull();
  }
  if (kind === "detached") {
    expect(pause).toHaveBeenCalledOnce();
    expect(source.srcObject).toBeNull();
  }
  if (kind === "reused stream") {
    expect(source.srcObject).toBe(replacement);
  }
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
    devices: [blackholeDevice("input")],
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
  const { result } = await runStatusScript(
    audioStatusParams({
      devices: [blackholeDevice("input")],
      deviceSettings,
      microphoneDevice: undefined,
      ...(kind === "display"
        ? { microphoneDeviceAfterSettings: selected }
        : { microphoneDeviceMenuAfterSettings: menu }),
      priorMeeting: {
        identity,
        ...(kind === "display" ? { audioInputDeviceId: "blackhole-input" } : {}),
      },
    }),
  );
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

const remoteMedia = (params: Partial<PageMedia> = {}) =>
  pageMedia({ muted: false, sinkId: "built-in-output", ...params });
const unloadedRemoteMedia = (stream = liveMediaStream()) =>
  abortingMedia("The element has no supported source.", {
    muted: false,
    sinkId: "built-in-output",
    srcObject: stream,
  });

function pendingSource() {
  const source = remoteMedia({
    async setSinkId(value) {
      if (!source.srcObject) {
        throw new DOMException("The element has no supported source.", "AbortError");
      }
      source.sinkId = value;
    },
  });
  return source;
}

const playableBridge = () => pageMedia({ isConnected: false, async play() {} });
const mutedSource = (stream = liveMediaStream()) =>
  remoteMedia({ muted: true, srcObject: stream, async setSinkId() {} });
function trackedBridge(params: Partial<PageMedia> = {}) {
  return {
    ...pageMedia({ sinkId: "blackhole-output", async setSinkId() {}, ...params }),
    pause: vi.fn(),
    remove: vi.fn(),
  };
}
function expectCleanup(bridge: ReturnType<typeof trackedBridge>, count = 1) {
  expect(bridge.pause).toHaveBeenCalledTimes(count);
  expect(bridge.remove).toHaveBeenCalledTimes(count);
}
function expectOutputs(window: Record<string, unknown>, entry: Record<string, unknown>) {
  expect(window[AUDIO_OUTPUTS]).toEqual([expect.objectContaining(entry)]);
}
const ownedOutput = (source: PageMedia, bridge: PageMedia) =>
  audioEntry(source, bridge, { playing: true, stream: source.srcObject });

it.each(["NotAllowedError", "AbortError"])("retries bridge playback after %s", async (error) => {
  const source = unloadedRemoteMedia();
  let playAttempts = 0;
  let plays = false;
  const order: string[] = [];
  const bridge = pageMedia({
    isConnected: false,
    async setSinkId(value) {
      expect(source.muted).toBe(true);
      order.push("sink");
      bridge.sinkId = value;
    },
    async play() {
      expect(source.muted).toBe(true);
      expect(bridge.sinkId).toBe("blackhole-output");
      order.push("play");
      playAttempts += 1;
      if (!plays) {
        throw new DOMException("Playback blocked.", error);
      }
    },
  });
  const params = audioStatusParams({ bridgeMedia: bridge, media: [source] });
  let page: Awaited<ReturnType<typeof runStatusScript>> | undefined;
  const states = error === "AbortError" ? [true, false, true] : [false, false];
  for (plays of states) {
    page = page ? await continueStatusScript(page, params) : await runStatusScript(params);
    expect(page.result.audioOutputRouted).toBe(plays);
    if (!plays) {
      expect(page.result.audioOutputRouteRetryable).toBe(error === "AbortError");
    }
    expect(source.muted).toBe(true);
    if (plays) {
      expect(page.result.audioInputRouted).toBe(true);
      expect(page.result.manualAction).toBeUndefined();
      expect((page.window[AUDIO_OUTPUTS] as Array<{ bridge: PageMedia }>)[0]?.bridge).toBe(bridge);
    }
    params.media = [source, bridge];
  }
  expect(order.slice(0, 2)).toEqual(["sink", "play"]);
  expect(bridge).toMatchObject({ autoplay: false, sinkId: "blackhole-output" });
  expect(playAttempts).toBe(states.length);
});

it.each([false, true])(
  "retries pending audio only in its original meeting (changed=%s)",
  async (changed) => {
    const source = pendingSource();
    const params = audioStatusParams({ media: [source] });
    const first = await runStatusScript(params);
    expect(first.result).toMatchObject({
      audioOutputRouted: false,
      audioOutputRouteRetryable: true,
    });
    expect(first.result.audioOutputRouteError).toBeUndefined();
    expect(source.muted).toBe(true);
    expectOutputs(first.window, { pending: true, source, sourceMuted: false });
    source.srcObject = liveMediaStream();
    expect(source).toMatchObject({ sinkId: "built-in-output", muted: true });
    const second = await continueStatusScript(first, {
      ...params,
      currentUrl: changed
        ? "https://teams.microsoft.com/l/meetup-join/19%3ameeting_other%40thread.v2/0"
        : undefined,
    });
    if (changed) {
      expect(source).toMatchObject({ sinkId: "built-in-output", muted: true });
      expect(second.result.manualAction).toMatchObject({ reason: "teams-session-conflict" });
    } else {
      expect(second.result.audioOutputRouted).toBe(true);
      expect(source.muted).toBe(false);
    }
    expect(second.window).not.toHaveProperty(AUDIO_OUTPUTS);
  },
);

it("restores an unclaimed source when another source from its entry is rerouted", async () => {
  const current = remoteMedia({ currentSrc: "blob:https://teams.live.com/current", muted: true });
  const unclaimed = remoteMedia({
    currentSrc: "blob:https://teams.live.com/unclaimed",
    muted: true,
    async setSinkId() {},
  });

  const { result, window } = await runAudioStatusScript({
    media: [current],
    priorAudioOutputs: [
      {
        sessionId: "session-1",
        sources: [
          { element: current, muted: false, url: current.currentSrc },
          { element: unclaimed, muted: false, url: unclaimed.currentSrc },
        ],
      },
    ],
  });

  expect(result.audioOutputRouted).toBe(true);
  expect([current.muted, unclaimed.muted]).toEqual([false, false]);
  expect(window).not.toHaveProperty(AUDIO_OUTPUTS);
});

it.each(["replacement", "detached"])("tracks a bridged source through %s", async (kind) => {
  const detached = kind === "detached";
  const firstStream = liveMediaStream();
  const replacementStream = liveMediaStream();
  const source = unloadedRemoteMedia(firstStream);
  const directSource = remoteMedia({ srcObject: firstStream });
  const bridge = playableBridge();
  const params = audioStatusParams({ bridgeMedia: bridge });
  const media = detached ? [directSource] : [source, directSource];
  const initial = detached ? [source] : media;
  const first = await runStatusScript({ ...params, media: initial });
  expect(first.result.audioOutputRouted).toBe(true);
  expect(source.muted).toBe(true);
  if (!detached) {
    expect(directSource.muted).toBe(false);
  }
  expectOutputs(first.window, { source, stream: firstStream });
  if (!detached) {
    source.srcObject = undefined;
  }
  const second = await continueStatusScript(first, { ...params, media });
  expect(second.result.audioOutputRouted).toBe(detached);
  expect(source.muted).toBe(true);
  expectOutputs(second.window, {
    source,
    sourceMuted: false,
    ...(detached ? { detached: true, suspended: true } : { pending: true }),
  });
  source.srcObject = detached ? undefined : replacementStream;
  const third = await continueStatusScript(second, { ...params, media });
  expect(source.muted).toBe(true);
  if (detached) {
    expect(third.window).not.toHaveProperty(AUDIO_OUTPUTS);
  } else {
    expect(third.result.audioOutputRouted).toBe(true);
    expect((third.window[AUDIO_OUTPUTS] as Array<{ stream: unknown }>)[0]?.stream).toBe(
      replacementStream,
    );
  }
});

it("tears down audio bridges and restores sources after the call ends", async () => {
  const source = unloadedRemoteMedia();
  const bridge = { ...playableBridge(), pause: vi.fn(), remove: vi.fn() };
  const first = await runAudioStatusScript({ bridgeMedia: bridge, media: [source] });
  expect(source.muted).toBe(true);

  const ended = await continueStatusScript(first, { allowMicrophone: true });
  expect(source.muted).toBe(false);
  expectCleanup(bridge);
  expect(ended.window).not.toHaveProperty(AUDIO_OUTPUTS);
});

it("suspends bridge ownership while an in-call media list is temporarily empty", async () => {
  const stream = liveMediaStream();
  const source = mutedSource(stream);
  const bridge = trackedBridge();

  const { result, window } = await runStatusScript({
    allowMicrophone: true,
    devices: [blackholeDevice("output")],
    leave: control({ label: "Leave" }),
    media: [],
    priorAudioOutputs: [ownedOutput(source, bridge)],
    priorMeeting: { identity },
  });

  expect(source.muted).toBe(true);
  expect(result.audioOutputRouteRetryable).toBe(true);
  expect(source.srcObject).toBe(stream);
  expectCleanup(bridge);
  expectOutputs(window, { source, sourceMuted: false, stream, suspended: true });
});

it.each([false, true])("handles a missing BlackHole output (readOnly=%s)", async (readOnly) => {
  const source = mutedSource();
  const bridge = trackedBridge({ isConnected: true });
  const activeBridge = ownedOutput(source, bridge);
  const { result, window } = await runAudioStatusScript({
    devices: [blackholeDevice("input")],
    media: [source],
    priorAudioOutputs: [activeBridge],
    readOnly,
  });
  expect(source.muted).toBe(true);
  expectCleanup(bridge, readOnly ? 0 : 1);
  if (readOnly) {
    expect(window[AUDIO_OUTPUTS]).toEqual([activeBridge]);
  } else {
    expect(result.audioOutputRouteRetryable).toBe(false);
    expectOutputs(window, { source, sourceMuted: false, suspended: true });
  }
});

it("reassigns a prior session bridge source after the new session identity is verified", async () => {
  const stream = liveMediaStream();
  const source: PageMedia = { muted: true, sinkId: "", srcObject: stream, async setSinkId() {} };
  const emptySource: PageMedia = { muted: true, sinkId: "", async setSinkId() {} };
  const bridge = trackedBridge({ sinkId: "" });
  const { window } = await runStatusScript({
    leave: control({ label: "Leave" }),
    priorAudioOutputs: [
      {
        bridge,
        playing: true,
        sessionId: "old-session",
        sources: [
          { element: source, muted: false, stream },
          { element: emptySource, muted: false },
        ],
      },
      audioEntry(source, { ...bridge }, { playing: true, sessionId: "old-session", stream }),
    ],
    priorMeeting: meetingOwner({ sessionId: "old-session" }),
  });

  expect([source.muted, emptySource.muted]).toEqual([true, true]);
  expectCleanup(bridge, 2);
  expectOutputs(window, { sessionId: "session-1", source, sourceMuted: false, suspended: true });
});

it("keeps a loaded non-MediaStream AbortError retryable", async () => {
  const routed = pageMedia();
  const loaded = abortingMedia("Cannot route loaded media.", {
    currentSrc: "blob:https://teams.live.com/remote-audio",
    readyState: 4,
    sinkId: "built-in-output",
  });
  const { result } = await runAudioStatusScript({ media: [routed, loaded] });

  expect(result).toMatchObject({
    audioOutputRouteError: "Cannot route loaded media.",
    audioOutputRouteRetryable: true,
    audioOutputRouted: false,
    manualAction: { reason: "teams-audio-choice-required" },
  });
});

it("preserves Teams mute state and ignores a muted local media stream", async () => {
  const remote = pageMedia({ muted: false, srcObject: liveMediaStream() });
  const setSinkId = vi.fn(async () => {});
  const local = pageMedia({
    muted: true,
    sinkId: "built-in-output",
    srcObject: liveMediaStream(),
    setSinkId,
  });
  const params = audioStatusParams();
  const pending = await runStatusScript({ ...params, media: [local] });
  expect(pending.result).toMatchObject({
    audioInputRouted: true,
    audioOutputRouted: false,
    audioOutputRouteRetryable: true,
  });

  const { result } = await runStatusScript({ ...params, media: [remote, local] });

  expect(result.audioOutputRouted).toBe(true);
  expect(local.muted).toBe(true);
  expect(setSinkId).not.toHaveBeenCalled();
});

it("mutes an in-call physical microphone when Teams resets the prejoin selection", async () => {
  const microphone = toggleOff("microphone");
  const { result } = await runAudioStatusScript({
    devices: [blackholeDevice("input")],
    microphone,
    microphoneDevice: control({ label: "MacBook Pro Microphone" }),
    priorMeeting: { audioInputDeviceId: "blackhole-input", identity },
  });

  expect(result).toMatchObject({
    audioInputRouted: false,
    manualAction: { reason: "teams-audio-choice-required" },
    micMuted: true,
  });
  expect(microphone.clicks).toBe(1);
});
