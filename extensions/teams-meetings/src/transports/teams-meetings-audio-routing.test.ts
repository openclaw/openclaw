import { expect, it, vi } from "vitest";
import {
  abortingMedia,
  audioStatusParams,
  continueStatusScript,
  control,
  liveMediaStream,
  pageMedia,
  runAudioStatusScript,
  runStatusScript,
  type PageMedia,
} from "./teams-meetings-platform-adapter.test-helpers.js";

function unloadedRemoteMedia(stream = liveMediaStream()) {
  return abortingMedia("The element has no supported source.", {
    muted: false,
    sinkId: "built-in-output",
    srcObject: stream,
  });
}

function pendingSource() {
  const source = pageMedia({
    muted: false,
    sinkId: "built-in-output",
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
  pageMedia({
    muted: true,
    sinkId: "built-in-output",
    srcObject: stream,
    async setSinkId() {},
  });
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
  expect(window["__openclawTeamsAudioOutputs"]).toEqual([expect.objectContaining(entry)]);
}
const ownedOutput = (source: PageMedia, bridge: PageMedia) => ({
  bridge,
  playing: true,
  sessionId: "session-1",
  source,
  sourceMuted: false,
  stream: source.srcObject,
});

it("retries bridge playback instead of trusting a previously selected sink", async () => {
  const source = unloadedRemoteMedia();
  let playAttempts = 0;
  const bridge = pageMedia({
    isConnected: false,
    async play() {
      playAttempts += 1;
      throw new DOMException("Playback blocked.", "NotAllowedError");
    },
  });
  const params = audioStatusParams({
    bridgeMedia: bridge,
    media: [source],
    priorMeeting: {
      audioInputDeviceId: "blackhole-input",
      identity: "teams-work:19:meeting_test@thread.v2",
    },
  });
  const first = await runStatusScript(params);
  const second = await continueStatusScript(first, params);

  expect(first.result.audioOutputRouted).toBe(false);
  expect(first.result.audioOutputRouteRetryable).toBe(false);
  expect(second.result.audioOutputRouted).toBe(false);
  expect(playAttempts).toBe(2);
  expect(source.muted).toBe(true);
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
    expectOutputs(first.window, { pending: true, source, sourceMuted: false });
    const second = await continueStatusScript(first, {
      ...params,
      ...(changed
        ? {
            currentUrl:
              "https://teams.microsoft.com/l/meetup-join/19%3ameeting_other%40thread.v2/0",
          }
        : {}),
    });
    if (changed) {
      expect(source).toMatchObject({ sinkId: "built-in-output", muted: true });
      expect(second.result.manualAction).toMatchObject({ reason: "teams-session-conflict" });
    } else {
      expect(second.result.audioOutputRouted).toBe(true);
      expect(source.muted).toBe(false);
    }
    expect(second.window).not.toHaveProperty("__openclawTeamsAudioOutputs");
  },
);

it("keeps the source muted when a previously working bridge fails", async () => {
  const source = unloadedRemoteMedia();
  let failPlayback = false;
  const bridge = pageMedia({
    isConnected: false,
    async play() {
      if (failPlayback) {
        throw new DOMException("Playback failed.", "AbortError");
      }
    },
  });
  const params = audioStatusParams({ bridgeMedia: bridge, media: [source] });
  const first = await runStatusScript(params);
  expect(first.result.audioOutputRouted).toBe(true);
  expect(source.muted).toBe(true);

  failPlayback = true;
  const second = await continueStatusScript(first, params);
  expect(second.result.audioOutputRouted).toBe(false);
  expect(second.result.audioOutputRouteRetryable).toBe(true);
  expect(source.muted).toBe(true);

  failPlayback = false;
  const third = await continueStatusScript(second, params);
  expect(third.result.audioOutputRouted).toBe(true);
  expect(source.muted).toBe(true);
});

it("restores an unclaimed source when another source from its entry is rerouted", async () => {
  const current = pageMedia({
    currentSrc: "blob:https://teams.live.com/current",
    muted: true,
    sinkId: "built-in-output",
  });
  const unclaimed = pageMedia({
    currentSrc: "blob:https://teams.live.com/unclaimed",
    muted: true,
    sinkId: "built-in-output",
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
  expect(current.muted).toBe(false);
  expect(unclaimed.muted).toBe(false);
  expect(window).not.toHaveProperty("__openclawTeamsAudioOutputs");
});

it("reroutes a replacement stream on an element muted by its prior bridge", async () => {
  const firstStream = liveMediaStream();
  const replacementStream = liveMediaStream();
  const source = unloadedRemoteMedia(firstStream);
  const directSource = pageMedia({
    muted: false,
    sinkId: "built-in-output",
    srcObject: firstStream,
  });
  const bridge = playableBridge();
  const params = audioStatusParams({ bridgeMedia: bridge, media: [source, directSource] });
  const first = await runStatusScript(params);
  expect(first.result.audioOutputRouted).toBe(true);
  expect(source.muted).toBe(true);
  expect(directSource.muted).toBe(false);
  expectOutputs(first.window, { source, stream: firstStream });

  source.srcObject = undefined;
  const second = await continueStatusScript(first, params);
  expect(second.result.audioOutputRouted).toBe(false);
  expect(source.muted).toBe(true);
  expectOutputs(second.window, { pending: true, source, sourceMuted: false });

  source.srcObject = replacementStream;
  const third = await continueStatusScript(second, params);
  expect(third.result.audioOutputRouted).toBe(true);
  expect(source.muted).toBe(true);
  expect(
    (third.window["__openclawTeamsAudioOutputs"] as Array<{ stream: unknown }>)[0]?.stream,
  ).toBe(replacementStream);
});

it("keeps a detached source muted after its owned stream is cleared", async () => {
  const stream = liveMediaStream();
  const source = unloadedRemoteMedia(stream);
  const directSource = pageMedia({ muted: false, sinkId: "built-in-output", srcObject: stream });
  const bridge = playableBridge();
  const params = audioStatusParams({ bridgeMedia: bridge });
  const first = await runStatusScript({ ...params, media: [source] });
  expect(source.muted).toBe(true);

  const second = await continueStatusScript(first, { ...params, media: [directSource] });
  expect(second.result.audioOutputRouted).toBe(true);
  expect(source.muted).toBe(true);
  expectOutputs(second.window, { detached: true, source, sourceMuted: false, suspended: true });

  source.srcObject = undefined;
  const third = await continueStatusScript(second, { ...params, media: [directSource] });
  expect(source.muted).toBe(true);
  expect(third.window).not.toHaveProperty("__openclawTeamsAudioOutputs");
});

it("tears down audio bridges and restores sources after the call ends", async () => {
  const source = unloadedRemoteMedia();
  const bridge = { ...playableBridge(), pause: vi.fn(), remove: vi.fn() };
  const first = await runAudioStatusScript({ bridgeMedia: bridge, media: [source] });
  expect(source.muted).toBe(true);

  const ended = await continueStatusScript(first, { allowMicrophone: true });
  expect(source.muted).toBe(false);
  expectCleanup(bridge);
  expect(ended.window).not.toHaveProperty("__openclawTeamsAudioOutputs");
});

it("suspends bridge ownership while an in-call media list is temporarily empty", async () => {
  const stream = liveMediaStream();
  const source = mutedSource(stream);
  const bridge = trackedBridge();

  const { result, window } = await runStatusScript({
    allowMicrophone: true,
    devices: [{ deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" }],
    leave: control({ label: "Leave" }),
    media: [],
    priorAudioOutputs: [ownedOutput(source, bridge)],
    priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
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
    devices: [{ deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" }],
    media: [source],
    priorAudioOutputs: [activeBridge],
    readOnly,
  });
  expect(source.muted).toBe(true);
  expectCleanup(bridge, readOnly ? 0 : 1);
  if (readOnly) {
    expect(window["__openclawTeamsAudioOutputs"]).toEqual([activeBridge]);
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
      {
        bridge: { ...bridge },
        playing: true,
        sessionId: "old-session",
        source,
        sourceMuted: false,
        stream,
      },
    ],
    priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2", sessionId: "old-session" },
  });

  expect(source.muted).toBe(true);
  expect(emptySource.muted).toBe(true);
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
  const microphone = control({
    label: "Turn microphone off",
    pressed: true,
    onClick: (node) => node.setPressed(false),
  });
  const { result } = await runStatusScript({
    allowMicrophone: true,
    devices: [{ deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" }],
    leave: control({ label: "Leave" }),
    microphone,
    microphoneDevice: control({ label: "MacBook Pro Microphone" }),
    priorMeeting: {
      audioInputDeviceId: "blackhole-input",
      identity: "teams-work:19:meeting_test@thread.v2",
    },
  });

  expect(result).toMatchObject({
    audioInputRouted: false,
    manualAction: { reason: "teams-audio-choice-required" },
    micMuted: true,
  });
  expect(microphone.clicks).toBe(1);
});
