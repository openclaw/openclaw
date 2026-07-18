import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  teamsMeetingLeaveScript,
  teamsMeetingStatusScript,
  teamsMeetingTranscriptScript,
} from "./teams-meetings-page-scripts.js";
import {
  TEAMS_MEETINGS_PLATFORM_ADAPTER,
  isTeamsMeetingsRealtimeRouteReady,
} from "./teams-meetings-platform-adapter.js";

const URL =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_test%40thread.v2/0?context=%7b%7d";
const CONSUMER_URL = "https://teams.live.com/meet/9326458712345?p=abc";
const MEETING_STATE_KEY = "__openclawTeamsMeeting";

function consumerLightMeetingUrl(meetingCode: string, passcode: string) {
  const coordinates = btoa(JSON.stringify({ meetingCode, passcode }));
  return `https://teams.live.com/light-meetings/launch?coords=${encodeURIComponent(coordinates)}`;
}

function status(manualActionReason: string, manualActionMessage = "manual action") {
  const health = TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.parseStatus({
    result: JSON.stringify({
      inCall: false,
      manualActionRequired: true,
      manualActionReason,
      manualActionMessage,
      url: URL,
    }),
  });
  if (!health) {
    throw new Error("expected parsed health");
  }
  return health;
}

type PageControl = {
  checked?: boolean;
  disabled?: boolean;
  clicks: number;
  isConnected: boolean;
  click(): void;
  closest(selector?: string): PageControl;
  getAttribute(name: string): string | null;
  matches(selector: string): boolean;
  querySelector(selector?: string): PageControl | undefined;
  querySelectorAll?(selector: string): PageControl[];
  setPressed(pressed: boolean): void;
  textContent: string;
};

type PageMedia = {
  autoplay?: boolean;
  currentSrc?: string;
  hidden?: boolean;
  id?: string;
  isConnected?: boolean;
  muted?: boolean;
  readyState?: number;
  sinkId: string;
  src?: string;
  srcObject?: { getAudioTracks(): Array<{ readyState: string }> };
  play?(): Promise<void>;
  pause?(): void;
  remove?(): void;
  setSinkId(value: string): Promise<void>;
};

function control(params: {
  checked?: boolean;
  label: string;
  text?: string;
  pressed?: boolean;
  onClick?: (control: PageControl) => void;
}): PageControl {
  const attributes = new Map<string, string>([["aria-label", params.label]]);
  if (params.pressed !== undefined) {
    attributes.set("aria-pressed", String(params.pressed));
  }
  const node: PageControl = {
    ...(params.checked === undefined ? {} : { checked: params.checked }),
    clicks: 0,
    isConnected: true,
    textContent: params.text ?? "",
    click() {
      node.clicks += 1;
      params.onClick?.(node);
    },
    closest: () => node,
    getAttribute: (name) => attributes.get(name) ?? null,
    matches: (selector) => selector === "button",
    querySelector: () => undefined,
    setPressed: (pressed) => attributes.set("aria-pressed", String(pressed)),
  };
  return node;
}

function captionRow(speaker: string, captionText: string): PageControl {
  const author = control({ label: "", text: speaker });
  const content = control({ label: "", text: captionText });
  const row = control({ label: "" });
  row.querySelector = (selector) => {
    if (selector?.includes('data-tid="author"')) return author;
    if (selector?.includes('data-tid="closed-caption-text"')) return content;
    return undefined;
  };
  return row;
}

async function runStatusScript(params: {
  allowMicrophone: boolean;
  autoJoin?: boolean;
  bodyText?: string;
  currentUrl?: string;
  meetingUrl?: string;
  microphone?: PageControl;
  camera?: PageControl;
  captionClickIgnored?: boolean;
  captionsInitiallyOn?: boolean;
  captionRows?: PageControl[];
  captureCaptions?: boolean;
  bridgeMedia?: PageMedia | PageMedia[];
  continueWithoutDevices?: PageControl;
  deviceSettings?: PageControl;
  join?: PageControl;
  leave?: PageControl;
  microphoneDevice?: PageControl;
  microphoneDeviceAfterSettings?: PageControl;
  microphoneDeviceMenuAfterSettings?: PageControl;
  microphonePermissionState?: "denied" | "granted" | "prompt";
  permissionPrompt?: PageControl;
  priorAudioOutputs?: unknown[];
  priorCaptions?: unknown;
  priorMeeting?: Record<string, unknown>;
  readOnly?: boolean;
  globalSelectedOption?: PageControl;
  media?: PageMedia[];
  devices?: Array<{ deviceId: string; kind: string; label: string }>;
}) {
  const currentUrl = params.currentUrl ?? URL;
  const location = new globalThis.URL(currentUrl);
  const controls = [
    params.microphone,
    params.camera,
    params.continueWithoutDevices,
    params.deviceSettings,
    params.join,
    params.leave,
  ].filter((entry): entry is PageControl => Boolean(entry));
  let captionMenuOpen = false;
  let captionsOn = params.captionsInitiallyOn ?? Boolean(params.priorCaptions);
  const moreActions = control({
    label: "More",
    onClick: () => {
      captionMenuOpen = true;
    },
  });
  const captionButton = control({
    label: "Captions Show live captions",
    onClick: () => {
      if (!params.captionClickIgnored) captionsOn = true;
    },
  });
  const captionContent = control({ label: "", text: "" });
  captionContent.querySelectorAll = () => params.captionRows ?? [];
  const captionRenderer = control({ label: "Live Captions" });

  const body = {
    textContent: params.bodyText ?? "",
    appendChild(node: PageMedia) {
      node.isConnected = true;
    },
  };
  let bridgeMediaIndex = 0;
  const document = {
    body,
    createElement() {
      if (!params.bridgeMedia) throw new Error("unexpected media bridge");
      if (!Array.isArray(params.bridgeMedia)) return params.bridgeMedia;
      const bridge = params.bridgeMedia[bridgeMediaIndex++];
      if (!bridge) throw new Error("missing media bridge fixture");
      return bridge;
    },
    title: "Teams",
    getElementById() {
      return undefined;
    },
    querySelector(selector: string) {
      if (selector.includes("toggle-mute")) {
        return params.microphone;
      }
      if (selector.includes("toggle-video")) {
        return params.camera;
      }
      if (selector.includes("prejoin-join-button")) {
        return params.join;
      }
      if (selector.includes("call-hangup")) {
        return params.leave;
      }
      if (selector.includes("hangup-button")) {
        return params.leave;
      }
      if (selector.includes("More")) {
        return params.captionRows ? moreActions : undefined;
      }
      if (selector.includes("closed-captions-button") || selector.includes("title*=")) {
        return params.captionRows && captionMenuOpen ? captionButton : undefined;
      }
      if (selector.includes("closed-caption-renderer-wrapper")) {
        return params.captionRows && captionsOn ? captionRenderer : undefined;
      }
      if (selector.includes("closed-caption-v2-virtual-list-content")) {
        return params.captionRows && captionsOn ? captionContent : undefined;
      }
      if (
        selector.includes("audio-button-configure") ||
        selector.includes("Open audio options") ||
        selector.includes("device-settings-button")
      ) {
        return params.deviceSettings;
      }
      if (
        selector.includes("selected-microphone-display") ||
        selector.includes("microphone-select") ||
        selector.includes("audio-device-input") ||
        selector.includes("device-settings-microphone")
      ) {
        return params.deviceSettings?.clicks
          ? (params.microphoneDeviceAfterSettings ?? params.microphoneDevice)
          : params.microphoneDevice;
      }
      if (selector.includes("microphone-settings")) {
        return params.deviceSettings?.clicks
          ? (params.microphoneDeviceMenuAfterSettings ?? params.microphoneDeviceAfterSettings)
          : undefined;
      }
      if (selector.includes("permission-prompt") || selector.includes("permission-error")) {
        return params.permissionPrompt;
      }
      if (selector === '[role="option"][aria-selected="true"]') {
        return params.globalSelectedOption;
      }
      return undefined;
    },
    querySelectorAll(selector: string) {
      if (selector === "button") {
        return controls;
      }
      if (selector === "audio, video") {
        return params.media ?? [];
      }
      if (selector.includes('[role="option"]')) {
        return params.globalSelectedOption ? [params.globalSelectedOption] : [];
      }
      return [];
    },
  };
  const window: Record<string, unknown> = {};
  let captionObserverCallback: (() => void) | undefined;
  let captionObserverDisconnects = 0;
  if (params.priorMeeting) {
    window[MEETING_STATE_KEY] = params.priorMeeting;
  }
  if (params.priorAudioOutputs) {
    window.__openclawTeamsAudioOutputs = params.priorAudioOutputs;
  }
  if (params.priorCaptions) {
    window.__openclawTeamsCaptions = params.priorCaptions;
  }
  const script = teamsMeetingStatusScript({
    allowMicrophone: params.allowMicrophone,
    autoJoin: params.autoJoin ?? true,
    captureCaptions: params.captureCaptions ?? false,
    guestName: "OpenClaw Guest",
    meetingSessionId: "session-1",
    meetingUrl: params.meetingUrl ?? URL,
    readOnly: params.readOnly,
  });
  const run = runInNewContext(`(${script})`, {
    Event: globalThis.Event,
    HTMLInputElement: function HTMLInputElement() {},
    MutationObserver: class MutationObserver {
      constructor(callback: () => void) {
        captionObserverCallback = callback;
      }
      disconnect() {
        captionObserverDisconnects += 1;
      }
      observe() {}
    },
    URL: globalThis.URL,
    atob: globalThis.atob,
    crypto: { randomUUID: () => "teams-caption-epoch" },
    document,
    location,
    navigator: {
      mediaDevices: {
        enumerateDevices: async () => params.devices ?? [],
      },
      permissions: {
        query: async () => ({ state: params.microphonePermissionState ?? "prompt" }),
      },
    },
    setTimeout,
    window,
  }) as () => Promise<string>;
  return {
    captionButton,
    captionObserverDisconnects: () => captionObserverDisconnects,
    triggerCaptionMutation(nextUrl?: string) {
      if (nextUrl) location.href = nextUrl;
      captionObserverCallback?.();
    },
    result: JSON.parse(await run()) as Record<string, unknown>,
    window,
  };
}

function runLeaveScript(params: {
  bodyText?: string;
  currentUrl?: string;
  leave?: PageControl;
  postCall?: PageControl;
  priorMeeting?: Record<string, unknown>;
}) {
  const currentUrl = params.currentUrl ?? URL;
  const location = new globalThis.URL(currentUrl);
  const document = {
    body: { textContent: params.bodyText ?? "" },
    querySelector(selector: string) {
      if (selector.includes("call-hangup")) {
        return params.leave;
      }
      if (
        selector.includes("call-ended-screen") ||
        selector.includes("post-call-screen") ||
        selector.includes("prejoin-rejoin-button")
      ) {
        return params.postCall;
      }
      return undefined;
    },
  };
  const window: Record<string, unknown> = {};
  if (params.priorMeeting) {
    window[MEETING_STATE_KEY] = params.priorMeeting;
  }
  const run = runInNewContext(`(${teamsMeetingLeaveScript(URL)})`, {
    URL: globalThis.URL,
    document,
    location,
    window,
  }) as () => string;
  return { result: JSON.parse(run()) as Record<string, unknown>, window };
}

describe("Microsoft Teams meeting platform adapter", () => {
  it.each([
    ["teams-login-required", "login-required"],
    ["teams-admission-required", "admission-required"],
    ["teams-permission-required", "permission-required"],
    ["teams-audio-choice-required", "audio-choice-required"],
    ["teams-session-conflict", "session-conflict"],
    ["browser-control-unavailable", "browser-control-unavailable"],
  ])("classifies %s as %s", (reason, category) => {
    expect(TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.classifyManualAction(status(reason))).toEqual({
      category,
      reason,
      message: "manual action",
    });
  });

  it("retries transient in-call audio routing while Teams renders its media controls", () => {
    const retry = TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.shouldRetryJoinStatus;
    const pending = { ...status("teams-audio-choice-required"), inCall: true };

    expect(retry?.(pending)).toBe(true);
    expect(retry?.({ ...pending, audioOutputRouteError: "sink failed" })).toBe(false);
  });

  it.each([
    ["camera", "Turn camera off", undefined, "on"],
    ["camera", "Turn camera on", undefined, "off"],
    ["camera", "Stop video", undefined, "on"],
    ["camera", "Start video", undefined, "off"],
    ["camera", "Turn camera on", "true", "on"],
    ["microphone", "Mute", undefined, "on"],
    ["microphone", "Unmute", undefined, "off"],
    ["microphone", "Turn microphone off", undefined, "on"],
    ["microphone", "Turn microphone on", undefined, "off"],
    ["microphone", "Microphone is muted", undefined, "off"],
    ["microphone", "Turn microphone off", "false", "off"],
  ])(
    "parses %s control %j with aria-pressed %j as %s",
    async (kind, label, ariaPressed, expected) => {
      const target = control({
        label,
        ...(ariaPressed === undefined ? {} : { pressed: ariaPressed === "true" }),
      });
      const { result } = await runStatusScript({
        allowMicrophone: false,
        ...(kind === "camera" ? { camera: target } : { microphone: target }),
        readOnly: true,
      });
      expect(kind === "camera" ? result.cameraOff : result.micMuted).toBe(expected === "off");
    },
  );

  it.each([
    ["camera", true, false],
    ["camera", false, true],
    ["microphone", true, false],
    ["microphone", false, true],
  ])("reads the live %s switch checked=%s", async (kind, checked, expectedOff) => {
    const target = control({ checked, label: kind === "camera" ? "Camera" : "Microphone" });
    const { result } = await runStatusScript({
      allowMicrophone: false,
      ...(kind === "camera" ? { camera: target } : { microphone: target }),
      readOnly: true,
    });
    expect(kind === "camera" ? result.cameraOff : result.micMuted).toBe(expectedOff);
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

    const { result } = await runStatusScript({
      allowMicrophone: false,
      camera,
      join,
      microphone,
    });

    expect(result).toMatchObject({ cameraOff: true, clickedJoin: true, micMuted: true });
    expect(camera.clicks).toBe(1);
    expect(microphone.clicks).toBe(1);
    expect(join.clicks).toBe(1);
  });

  it("does not unmute or join until BlackHole is visibly selected as the Teams input", async () => {
    const camera = control({ label: "Turn camera on", pressed: false });
    const microphone = control({ label: "Turn microphone on", pressed: false });
    const join = control({ label: "Join now" });

    const { result } = await runStatusScript({
      allowMicrophone: true,
      camera,
      devices: [{ deviceId: "blackhole", kind: "audioinput", label: "BlackHole 2ch" }],
      join,
      microphone,
    });

    expect(result).toMatchObject({
      audioInputRouted: false,
      clickedJoin: false,
      manualActionReason: "teams-audio-choice-required",
      micMuted: true,
    });
    expect(microphone.clicks).toBe(0);
    expect(join.clicks).toBe(0);
  });

  it("does not auto-join talk-back when the microphone control is missing", async () => {
    const camera = control({ label: "Turn camera on", pressed: false });
    const join = control({ label: "Join now" });

    const { result } = await runStatusScript({
      allowMicrophone: true,
      camera,
      join,
    });

    expect(result).toMatchObject({
      manualActionReason: "teams-microphone-required",
      manualActionRequired: true,
    });
    expect(join.clicks).toBe(0);
  });

  it("does not accept a selected BlackHole speaker option as the microphone", async () => {
    const camera = control({ label: "Turn camera on", pressed: false });
    const microphone = control({ label: "Turn microphone on", pressed: false });
    const microphoneDevice = control({ label: "MacBook Pro Microphone" });
    const selectedSpeaker = control({ label: "BlackHole 2ch" });
    const join = control({ label: "Join now" });

    const { result } = await runStatusScript({
      allowMicrophone: true,
      camera,
      devices: [{ deviceId: "blackhole", kind: "audioinput", label: "BlackHole 2ch" }],
      globalSelectedOption: selectedSpeaker,
      join,
      microphone,
      microphoneDevice,
    });

    expect(result).toMatchObject({
      audioInputRouted: false,
      clickedJoin: false,
      manualActionReason: "teams-audio-choice-required",
    });
    expect(microphone.clicks).toBe(0);
  });

  it("does not stamp meeting identity onto unrelated Teams pages", async () => {
    const leave = control({ label: "Leave" });
    const { result, window } = await runStatusScript({
      allowMicrophone: false,
      currentUrl: "https://teams.microsoft.com/v2/",
      leave,
    });

    expect(result.inCall).toBe(false);
    expect(window).not.toHaveProperty("__openclawTeamsMeeting");
  });

  it("verifies the consumer prejoin redirect from its encoded meeting coordinates", async () => {
    const { result, window } = await runStatusScript({
      allowMicrophone: false,
      currentUrl: consumerLightMeetingUrl("9326458712345", "abc"),
      meetingUrl: CONSUMER_URL,
    });

    expect(result.manualActionRequired).toBe(false);
    expect(window[MEETING_STATE_KEY]).toMatchObject({
      identity: "teams-consumer:9326458712345:p:abc",
      sessionId: "session-1",
    });
  });

  it("rejects consumer prejoin coordinates for a different meeting", async () => {
    const { result, window } = await runStatusScript({
      allowMicrophone: false,
      currentUrl: consumerLightMeetingUrl("1111111111111", "other"),
      meetingUrl: CONSUMER_URL,
    });

    expect(result).toMatchObject({
      inCall: false,
      manualActionReason: "teams-session-conflict",
    });
    expect(window).not.toHaveProperty(MEETING_STATE_KEY);
  });

  it("preserves a verified identity only across an in-call URL transition", async () => {
    const leave = control({ label: "Leave" });
    const inCallUrl = "https://teams.microsoft.com/v2/";
    const priorMeeting = {
      identity: "teams-work:19:meeting_test@thread.v2",
      inCallControl: leave,
      inCallUrl,
      sessionId: "session-1",
    };
    const { result, window } = await runStatusScript({
      allowMicrophone: false,
      currentUrl: inCallUrl,
      leave,
      priorMeeting,
    });

    expect(result.inCall).toBe(true);
    expect(window[MEETING_STATE_KEY]).toMatchObject(priorMeeting);
  });

  it("adopts the first live hang-up control during the verified join transition", async () => {
    const prejoin = await runStatusScript({ allowMicrophone: false });
    const leave = control({ label: "Leave" });
    const admitted = await runStatusScript({
      allowMicrophone: false,
      currentUrl: "https://teams.microsoft.com/v2/",
      leave,
      priorMeeting: prejoin.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });

    expect(admitted.result.inCall).toBe(true);
    expect(admitted.window[MEETING_STATE_KEY]).toMatchObject({
      identity: "teams-work:19:meeting_test@thread.v2",
      inCallControl: leave,
      inCallUrl: "https://teams.microsoft.com/v2/",
    });
  });

  it("re-adopts a replaced hang-up control only within the bounded rerender window", async () => {
    const previousLeave = control({ label: "Leave" });
    previousLeave.isConnected = false;
    const currentLeave = control({ label: "Leave" });
    const inCallUrl = "https://teams.microsoft.com/v2/";
    const { result, window } = await runStatusScript({
      allowMicrophone: false,
      currentUrl: inCallUrl,
      leave: currentLeave,
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        inCallControl: previousLeave,
        inCallUrl,
        verifiedAt: Date.now(),
      },
    });

    expect(result.inCall).toBe(true);
    expect(window[MEETING_STATE_KEY]).toMatchObject({
      inCallControl: currentLeave,
      inCallUrl,
    });
  });

  it("does not trust a stale identity marker to leave a different SPA call", () => {
    const staleLeave = control({ label: "Leave old call" });
    const currentLeave = control({ label: "Leave current call" });
    const { result } = runLeaveScript({
      currentUrl: "https://teams.microsoft.com/v2/",
      leave: currentLeave,
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        inCallControl: staleLeave,
        inCallUrl: "https://teams.microsoft.com/v2/",
      },
    });

    expect(result).toEqual({ departed: false, urlMatched: false });
    expect(currentLeave.clicks).toBe(0);
  });

  it.each([
    "Alice: meeting ended — rejoin after lunch",
    "Bob: allow Teams to use your microphone; device permissions are blocked",
  ])("ignores participant-controlled in-call text: %s", async (bodyText) => {
    const leave = control({ label: "Leave" });
    const { result } = await runStatusScript({
      allowMicrophone: false,
      bodyText,
      leave,
    });

    expect(result).toMatchObject({
      inCall: true,
      manualActionRequired: false,
    });
  });

  it("classifies a stable device permission prompt outside the call", async () => {
    const { result } = await runStatusScript({
      allowMicrophone: false,
      permissionPrompt: control({ label: "Device permission prompt" }),
    });

    expect(result).toMatchObject({
      inCall: false,
      manualActionReason: "teams-permission-required",
      manualActionRequired: true,
    });
  });

  it("does not report a prompt that it just dismissed while Teams removes the DOM", async () => {
    const continueWithoutDevices = control({ label: "Continue without audio or video" });
    const { result } = await runStatusScript({
      allowMicrophone: false,
      continueWithoutDevices,
      permissionPrompt: control({ label: "Device permission prompt" }),
    });

    expect(result).toMatchObject({ manualActionRequired: false });
    expect(continueWithoutDevices.clicks).toBe(1);
  });

  it("does not treat the live camera troubleshooting banner as a media permission block", async () => {
    const join = control({ label: "Join now" });
    const { result } = await runStatusScript({
      allowMicrophone: true,
      bodyText: "Your camera is turned off\nGo to your device settings to troubleshoot",
      camera: control({ checked: false, label: "Camera" }),
      devices: [{ deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" }],
      join,
      microphone: control({ checked: true, label: "Microphone" }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
    });

    expect(result).toMatchObject({ clickedJoin: true, manualActionRequired: false });
    expect(join.clicks).toBe(1);
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

    expect(result).toMatchObject({ clickedJoin: true, manualActionRequired: false });
    expect(join.clicks).toBe(1);
  });

  it.each(["meeting ended", "call ended — rejoin"])(
    "does not infer departure from page-wide text: %s",
    (bodyText) => {
      const { result } = runLeaveScript({ bodyText });
      expect(result).toEqual({ departed: false, urlMatched: true });
    },
  );

  it("requires positive input and output route evidence before realtime", () => {
    expect(
      isTeamsMeetingsRealtimeRouteReady("agent", {
        audioInputRouted: true,
        audioOutputRouted: true,
        inCall: true,
        micMuted: false,
      }),
    ).toBe(true);
    for (const health of [
      { audioOutputRouted: true, inCall: true, micMuted: false },
      { audioInputRouted: true, inCall: true, micMuted: false },
      { audioInputRouted: true, audioOutputRouted: true, inCall: true },
    ]) {
      expect(isTeamsMeetingsRealtimeRouteReady("agent", health)).toBe(false);
    }
    expect(
      isTeamsMeetingsRealtimeRouteReady("transcribe", {
        audioInputRouted: true,
        audioOutputRouted: true,
        inCall: true,
        micMuted: false,
      }),
    ).toBe(false);
  });

  it("reports verified routes only after the exact input marker and output sink agree", async () => {
    const leave = control({ label: "Leave" });
    const microphone = control({ label: "Turn microphone off", pressed: true });
    const media = {
      sinkId: "",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      async setSinkId(value: string) {
        media.sinkId = value;
      },
    };
    const { result } = await runStatusScript({
      allowMicrophone: true,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave,
      media: [media],
      microphone,
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    });

    expect(result).toMatchObject({
      audioInputRouted: true,
      audioOutputRouted: true,
      inCall: true,
      manualActionRequired: false,
      micMuted: false,
    });
    expect(media.sinkId).toBe("blackhole-output");
  });

  it("reports the prepared session input during read-only status inspection", async () => {
    const media: PageMedia = { sinkId: "blackhole-output", async setSinkId() {} };
    const { result } = await runStatusScript({
      allowMicrophone: true,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [media],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "session-1",
      },
      readOnly: true,
    });

    expect(result).toMatchObject({
      audioInputRouted: true,
      audioOutputRouted: true,
      manualActionRequired: false,
    });
  });

  it("routes a directly playable media element before its MediaStream is attached", async () => {
    const media: PageMedia = {
      sinkId: "",
      async setSinkId(value) {
        media.sinkId = value;
      },
    };
    const { result } = await runStatusScript({
      allowMicrophone: true,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [media],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    });

    expect(result.audioOutputRouted).toBe(true);
    expect(media.sinkId).toBe("blackhole-output");
  });

  it("reopens in-call audio options to reverify the BlackHole input", async () => {
    const deviceSettings = control({ label: "Open audio options" });
    const { result } = await runStatusScript({
      allowMicrophone: true,
      devices: [{ deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" }],
      deviceSettings,
      leave: control({ label: "Leave" }),
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDeviceAfterSettings: control({ label: "BlackHole 2ch (Virtual)" }),
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    });

    expect(result).toMatchObject({
      audioInputRouted: true,
      inCall: true,
      micMuted: false,
    });
    expect(deviceSettings.clicks).toBe(1);
  });

  it("reads the selected in-call microphone from the live consumer listbox", async () => {
    const deviceSettings = control({ label: "Open audio options" });
    const selected = control({ label: "BlackHole 2ch (Virtual)" });
    selected.getAttribute = (name) =>
      name === "aria-selected" ? "true" : name === "aria-label" ? "BlackHole 2ch (Virtual)" : null;
    const microphoneMenu = control({ label: "Microphone devices" });
    microphoneMenu.querySelector = (selector) =>
      selector?.includes('aria-selected="true"') ? selected : undefined;
    const { result } = await runStatusScript({
      allowMicrophone: true,
      devices: [{ deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" }],
      deviceSettings,
      leave: control({ label: "Leave" }),
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDeviceMenuAfterSettings: microphoneMenu,
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    });

    expect(result).toMatchObject({ audioInputRouted: true, inCall: true, micMuted: false });
    expect(deviceSettings.clicks).toBe(1);
  });

  it("does not choose the audio-less fallback in talkback modes", async () => {
    const continueWithoutDevices = control({
      label: "Continue without audio or video",
    });
    await runStatusScript({
      allowMicrophone: true,
      continueWithoutDevices,
      microphone: control({ label: "Turn microphone on", pressed: false }),
    });
    expect(continueWithoutDevices.clicks).toBe(0);

    await runStatusScript({
      allowMicrophone: false,
      continueWithoutDevices,
      microphone: control({ label: "Turn microphone on", pressed: false }),
    });
    expect(continueWithoutDevices.clicks).toBe(1);

    await runStatusScript({
      allowMicrophone: false,
      autoJoin: false,
      continueWithoutDevices,
      microphone: control({ label: "Turn microphone on", pressed: false }),
    });
    expect(continueWithoutDevices.clicks).toBe(1);
  });

  it("bridges a live Teams MediaStream when its unloaded audio element rejects setSinkId", async () => {
    const source: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
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
    const { result, window } = await runStatusScript({
      allowMicrophone: true,
      bridgeMedia: bridge,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [source],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    });

    expect(bridge.autoplay).toBe(false);
    expect(routingOrder).toEqual(["sink", "play"]);
    expect(result).toMatchObject({
      audioInputRouted: true,
      audioOutputRouted: true,
      manualActionRequired: false,
    });
    expect(bridge.sinkId).toBe("blackhole-output");
    expect(source.muted).toBe(true);
    expect(window).toHaveProperty("__openclawTeamsAudioOutputs");
    expect((window.__openclawTeamsAudioOutputs as Array<{ bridge: PageMedia }>)[0]?.bridge).toBe(
      bridge,
    );

    const repeated = await runStatusScript({
      allowMicrophone: true,
      bridgeMedia: bridge,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [source, bridge],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorAudioOutputs: window.__openclawTeamsAudioOutputs as unknown[],
      priorMeeting: window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(repeated.result.audioOutputRouted).toBe(true);
    expect(
      (repeated.window.__openclawTeamsAudioOutputs as Array<{ bridge: PageMedia }>)[0]?.bridge,
    ).toBe(bridge);
  });

  it("does not let one routed element hide a failed live remote stream", async () => {
    const routed: PageMedia = {
      sinkId: "",
      async setSinkId(value) {
        routed.sinkId = value;
      },
    };
    const live: PageMedia = {
      sinkId: "built-in-output",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    const bridge: PageMedia = {
      isConnected: false,
      sinkId: "",
      async play() {},
      async setSinkId() {
        throw new DOMException("Cannot route bridge.", "AbortError");
      },
    };
    const { result } = await runStatusScript({
      allowMicrophone: true,
      bridgeMedia: bridge,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [routed, live],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    });

    expect(result).toMatchObject({
      audioInputRouted: true,
      audioOutputRouted: false,
      manualActionReason: "teams-audio-choice-required",
    });
  });

  it("does not let one routed element hide an unloaded pending remote stream", async () => {
    const routed: PageMedia = {
      sinkId: "",
      async setSinkId(value) {
        routed.sinkId = value;
      },
    };
    const pending: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    const { result, window } = await runStatusScript({
      allowMicrophone: true,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [routed, pending],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    });

    expect(result).toMatchObject({
      audioInputRouted: true,
      audioOutputRouted: false,
      manualActionReason: "teams-audio-choice-required",
    });
    expect(result.audioOutputRouteError).toBeUndefined();
    expect(window.__openclawTeamsAudioOutputs).toEqual([
      expect.objectContaining({ source: pending, suspended: true }),
    ]);
  });

  it("retries bridge playback instead of trusting a previously selected sink", async () => {
    const source: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    let playAttempts = 0;
    const bridge: PageMedia = {
      isConnected: false,
      sinkId: "",
      async play() {
        playAttempts += 1;
        throw new DOMException("Playback blocked.", "NotAllowedError");
      },
      async setSinkId(value) {
        bridge.sinkId = value;
      },
    };
    const params = {
      allowMicrophone: true,
      bridgeMedia: bridge,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [source],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    };
    const first = await runStatusScript(params);
    const second = await runStatusScript({
      ...params,
      priorAudioOutputs: first.window.__openclawTeamsAudioOutputs as unknown[],
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });

    expect(first.result.audioOutputRouted).toBe(false);
    expect(second.result.audioOutputRouted).toBe(false);
    expect(playAttempts).toBe(2);
    expect(source.muted).toBe(true);
  });

  it("retries a muted source when Teams attaches its MediaStream later", async () => {
    const source: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    const bridge: PageMedia = {
      isConnected: false,
      sinkId: "",
      async play() {},
      async setSinkId(value) {
        bridge.sinkId = value;
      },
    };
    const params = {
      allowMicrophone: true,
      bridgeMedia: bridge,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [source],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    };
    const first = await runStatusScript(params);
    expect(first.result.audioOutputRouted).toBe(false);
    expect(first.result.audioOutputRouteError).toBeUndefined();
    expect(source.muted).toBe(true);
    expect(first.window.__openclawTeamsAudioOutputs).toEqual([
      expect.objectContaining({ source, sourceMuted: false, suspended: true }),
    ]);

    source.srcObject = { getAudioTracks: () => [{ readyState: "live" }] };
    const second = await runStatusScript({
      ...params,
      priorAudioOutputs: first.window.__openclawTeamsAudioOutputs as unknown[],
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(second.result.audioOutputRouted).toBe(true);
    expect(source.muted).toBe(true);
    expect(second.window.__openclawTeamsAudioOutputs).toEqual([
      expect.objectContaining({ bridge, source, sourceMuted: false }),
    ]);
  });

  it("keeps the source muted when a previously working bridge fails", async () => {
    const source: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    let failPlayback = false;
    const bridge: PageMedia = {
      isConnected: false,
      sinkId: "",
      async play() {
        if (failPlayback) throw new DOMException("Playback failed.", "AbortError");
      },
      async setSinkId(value) {
        bridge.sinkId = value;
      },
    };
    const params = {
      allowMicrophone: true,
      bridgeMedia: bridge,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [source],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    };
    const first = await runStatusScript(params);
    expect(first.result.audioOutputRouted).toBe(true);
    expect(source.muted).toBe(true);

    failPlayback = true;
    const second = await runStatusScript({
      ...params,
      priorAudioOutputs: first.window.__openclawTeamsAudioOutputs as unknown[],
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(second.result.audioOutputRouted).toBe(false);
    expect(source.muted).toBe(true);

    failPlayback = false;
    const third = await runStatusScript({
      ...params,
      priorAudioOutputs: second.window.__openclawTeamsAudioOutputs as unknown[],
      priorMeeting: second.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(third.result.audioOutputRouted).toBe(true);
    expect(source.muted).toBe(true);
  });

  it("keeps a per-source bridge when another element sharing its stream routes directly", async () => {
    const stream = { getAudioTracks: () => [{ readyState: "live" }] };
    const bridgedSource: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: stream,
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    const directSource: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: stream,
      async setSinkId(value) {
        directSource.sinkId = value;
      },
    };
    const bridge: PageMedia = {
      isConnected: false,
      sinkId: "",
      async play() {},
      async setSinkId(value) {
        bridge.sinkId = value;
      },
    };
    const { result, window } = await runStatusScript({
      allowMicrophone: true,
      bridgeMedia: bridge,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [bridgedSource, directSource],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    });

    expect(result.audioOutputRouted).toBe(true);
    expect(bridgedSource.muted).toBe(true);
    expect(directSource.muted).toBe(false);
    expect(window.__openclawTeamsAudioOutputs).toHaveLength(1);
    expect((window.__openclawTeamsAudioOutputs as Array<{ source: unknown }>)[0]?.source).toBe(
      bridgedSource,
    );
  });

  it("reroutes a replacement stream on an element muted by its prior bridge", async () => {
    const firstStream = { getAudioTracks: () => [{ readyState: "live" }] };
    const replacementStream = { getAudioTracks: () => [{ readyState: "live" }] };
    const source: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: firstStream,
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    const directSource: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: firstStream,
      async setSinkId(value) {
        directSource.sinkId = value;
      },
    };
    const bridge: PageMedia = {
      isConnected: false,
      sinkId: "",
      async play() {},
      async setSinkId(value) {
        bridge.sinkId = value;
      },
    };
    const params = {
      allowMicrophone: true,
      bridgeMedia: bridge,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [source, directSource],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    };
    const first = await runStatusScript(params);
    expect(first.result.audioOutputRouted).toBe(true);
    expect(source.muted).toBe(true);

    source.srcObject = undefined;
    const second = await runStatusScript({
      ...params,
      priorAudioOutputs: first.window.__openclawTeamsAudioOutputs as unknown[],
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(second.result.audioOutputRouted).toBe(false);
    expect(source.muted).toBe(true);
    expect(second.window.__openclawTeamsAudioOutputs).toEqual([
      expect.objectContaining({ source, sourceMuted: false, suspended: true }),
    ]);

    source.srcObject = replacementStream;
    const third = await runStatusScript({
      ...params,
      priorAudioOutputs: second.window.__openclawTeamsAudioOutputs as unknown[],
      priorMeeting: second.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(third.result.audioOutputRouted).toBe(true);
    expect(source.muted).toBe(true);
    expect(
      (third.window.__openclawTeamsAudioOutputs as Array<{ stream: unknown }>)[0]?.stream,
    ).toBe(replacementStream);
  });

  it("restores and drops bridge ownership when its media element detaches", async () => {
    const stream = { getAudioTracks: () => [{ readyState: "live" }] };
    const source: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: stream,
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    const directSource: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: stream,
      async setSinkId(value) {
        directSource.sinkId = value;
      },
    };
    const bridge: PageMedia = {
      isConnected: false,
      sinkId: "",
      async play() {},
      async setSinkId(value) {
        bridge.sinkId = value;
      },
    };
    const params = {
      allowMicrophone: true,
      bridgeMedia: bridge,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    };
    const first = await runStatusScript({ ...params, media: [source] });
    expect(source.muted).toBe(true);

    const second = await runStatusScript({
      ...params,
      media: [directSource],
      priorAudioOutputs: first.window.__openclawTeamsAudioOutputs as unknown[],
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(second.result.audioOutputRouted).toBe(true);
    expect(source.muted).toBe(false);
    expect(second.window).not.toHaveProperty("__openclawTeamsAudioOutputs");
  });

  it("tears down audio bridges and restores sources after the call ends", async () => {
    const source: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    let pauses = 0;
    let removals = 0;
    const bridge: PageMedia = {
      isConnected: false,
      sinkId: "",
      async play() {},
      pause: () => (pauses += 1),
      remove: () => (removals += 1),
      async setSinkId(value) {
        bridge.sinkId = value;
      },
    };
    const first = await runStatusScript({
      allowMicrophone: true,
      bridgeMedia: bridge,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [source],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    });
    expect(source.muted).toBe(true);

    const ended = await runStatusScript({
      allowMicrophone: true,
      priorAudioOutputs: first.window.__openclawTeamsAudioOutputs as unknown[],
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(source.muted).toBe(false);
    expect(pauses).toBe(1);
    expect(removals).toBe(1);
    expect(ended.window).not.toHaveProperty("__openclawTeamsAudioOutputs");
  });

  it("tears down a bridge when the BlackHole output disappears in-call", async () => {
    const source: PageMedia = {
      muted: true,
      sinkId: "built-in-output",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      async setSinkId() {},
    };
    let pauses = 0;
    let removals = 0;
    const bridge: PageMedia = {
      isConnected: true,
      sinkId: "blackhole-output",
      pause: () => (pauses += 1),
      remove: () => (removals += 1),
      async setSinkId() {},
    };
    const { window } = await runStatusScript({
      allowMicrophone: true,
      devices: [{ deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" }],
      leave: control({ label: "Leave" }),
      media: [source],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorAudioOutputs: [
        {
          bridge,
          playing: true,
          sessionId: "session-1",
          source,
          sourceMuted: false,
          stream: source.srcObject,
        },
      ],
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    });

    expect(source.muted).toBe(true);
    expect(pauses).toBe(1);
    expect(removals).toBe(1);
    expect(window.__openclawTeamsAudioOutputs).toEqual([
      expect.objectContaining({ source, sourceMuted: false, suspended: true }),
    ]);
  });

  it("does not tear down audio bridges during read-only inspection", async () => {
    const source: PageMedia = {
      muted: true,
      sinkId: "built-in-output",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      async setSinkId() {},
    };
    let pauses = 0;
    let removals = 0;
    const bridge: PageMedia = {
      isConnected: true,
      sinkId: "blackhole-output",
      pause: () => (pauses += 1),
      remove: () => (removals += 1),
      async setSinkId() {},
    };
    const activeBridge = {
      bridge,
      playing: true,
      sessionId: "session-1",
      source,
      sourceMuted: false,
      stream: source.srcObject,
    };
    const { window } = await runStatusScript({
      allowMicrophone: true,
      devices: [{ deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" }],
      leave: control({ label: "Leave" }),
      media: [source],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorAudioOutputs: [activeBridge],
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
      readOnly: true,
    });

    expect(source.muted).toBe(true);
    expect(pauses).toBe(0);
    expect(removals).toBe(0);
    expect(window.__openclawTeamsAudioOutputs).toEqual([activeBridge]);
  });

  it("reassigns a prior session bridge source after the new session identity is verified", async () => {
    const source: PageMedia = { muted: true, sinkId: "", async setSinkId() {} };
    let pauses = 0;
    let removals = 0;
    const bridge: PageMedia = {
      sinkId: "",
      pause: () => (pauses += 1),
      remove: () => (removals += 1),
      async setSinkId() {},
    };
    const { window } = await runStatusScript({
      allowMicrophone: false,
      leave: control({ label: "Leave" }),
      priorAudioOutputs: [
        {
          bridge,
          playing: true,
          sessionId: "old-session",
          source,
          sourceMuted: false,
        },
      ],
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "old-session",
      },
    });

    expect(source.muted).toBe(true);
    expect(pauses).toBe(1);
    expect(removals).toBe(1);
    expect(window.__openclawTeamsAudioOutputs).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        source,
        sourceMuted: false,
        suspended: true,
      }),
    ]);
  });

  it("ignores an unrelated media element when the live remote stream is routed", async () => {
    const live: PageMedia = {
      sinkId: "",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      async setSinkId(value) {
        live.sinkId = value;
      },
    };
    const unrelated: PageMedia = {
      muted: true,
      sinkId: "built-in-output",
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    const { result } = await runStatusScript({
      allowMicrophone: true,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [live, unrelated],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    });

    expect(result).toMatchObject({
      audioInputRouted: true,
      audioOutputRouted: true,
      manualActionRequired: false,
    });
  });

  it("fails routing for a loaded non-MediaStream element that rejects its sink", async () => {
    const routed: PageMedia = {
      sinkId: "",
      async setSinkId(value) {
        routed.sinkId = value;
      },
    };
    const loaded: PageMedia = {
      currentSrc: "blob:https://teams.live.com/remote-audio",
      readyState: 4,
      sinkId: "built-in-output",
      async setSinkId() {
        throw new DOMException("Cannot route loaded media.", "AbortError");
      },
    };
    const { result } = await runStatusScript({
      allowMicrophone: true,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [routed, loaded],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    });

    expect(result).toMatchObject({
      audioOutputRouted: false,
      manualActionReason: "teams-audio-choice-required",
    });
  });

  it("preserves Teams mute state and ignores a muted local media stream", async () => {
    const remote: PageMedia = {
      muted: false,
      sinkId: "",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      async setSinkId(value) {
        remote.sinkId = value;
      },
    };
    let localRouteAttempts = 0;
    const local: PageMedia = {
      muted: true,
      sinkId: "built-in-output",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      async setSinkId() {
        localRouteAttempts += 1;
      },
    };
    const { result } = await runStatusScript({
      allowMicrophone: true,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [remote, local],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    });

    expect(result.audioOutputRouted).toBe(true);
    expect(local.muted).toBe(true);
    expect(localRouteAttempts).toBe(0);
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
      manualActionReason: "teams-audio-choice-required",
      micMuted: true,
    });
    expect(microphone.clicks).toBe(1);
  });

  it("builds the guest join script from centralized stable selectors and text fallbacks", () => {
    const script = teamsMeetingStatusScript({
      allowMicrophone: true,
      autoJoin: true,
      captureCaptions: true,
      guestName: "OpenClaw Guest",
      meetingSessionId: "session-1",
      meetingUrl: URL,
    });
    expect(script).toContain('data-tid=\\"prejoin-display-name-input\\"');
    expect(script).toContain('data-tid=\\"call-hangup\\"');
    expect(script).toContain("continue on this browser");
    expect(script).toContain("someone will let you in shortly");
    expect(script).toContain("setSinkId");
    expect(script).toContain("BlackHole");
  });

  it("enables live captions and captures the validated Teams caption row DOM", async () => {
    const leave = control({ label: "Leave" });
    const { result, window } = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "Copper lantern validates Teams captions seven.")],
      captureCaptions: true,
      leave,
    });

    expect(result).toMatchObject({
      captioning: true,
      captionsEnabledAttempted: true,
      inCall: true,
      lastCaptionSpeaker: "OpenClaw QA",
      lastCaptionText: "Copper lantern validates Teams captions seven.",
      transcriptLines: 1,
    });
    const readTranscript = runInNewContext(
      `(${teamsMeetingTranscriptScript(URL, "session-1", false)})`,
      {
        URL: globalThis.URL,
        clearTimeout,
        document: {},
        location: new globalThis.URL(URL),
        window,
      },
    ) as () => string;
    expect(JSON.parse(readTranscript())).toMatchObject({
      droppedLines: 0,
      epoch: "teams-caption-epoch",
      lines: [
        {
          speaker: "OpenClaw QA",
          text: "Copper lantern validates Teams captions seven.",
        },
      ],
      sessionMatched: true,
      urlMatched: true,
    });
  });

  it("retries an unverified live-caption activation", async () => {
    const first = await runStatusScript({
      allowMicrophone: false,
      captionClickIgnored: true,
      captionsInitiallyOn: false,
      captionRows: [captionRow("OpenClaw QA", "Retry captions")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    expect(first.captionButton.clicks).toBe(1);
    expect(first.result).toMatchObject({
      captioning: false,
      captionsEnabledAttempted: false,
    });

    const second = await runStatusScript({
      allowMicrophone: false,
      captionsInitiallyOn: false,
      captionRows: [captionRow("OpenClaw QA", "Retry captions")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: first.window.__openclawTeamsCaptions,
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(second.captionButton.clicks).toBe(1);
    expect(second.result).toMatchObject({
      captioning: true,
      captionsEnabledAttempted: true,
    });
  });

  it("preserves valid one-character caption lines", async () => {
    const { result } = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "I")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });

    expect(result).toMatchObject({
      lastCaptionText: "I",
      recentTranscript: [{ speaker: "OpenClaw QA", text: "I" }],
      transcriptLines: 1,
    });
  });

  it("bounds visible and committed caption rows together", async () => {
    const { result, window } = await runStatusScript({
      allowMicrophone: false,
      captionRows: Array.from({ length: 505 }, (_, index) =>
        captionRow("OpenClaw QA", `Bounded caption ${index}`),
      ),
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    const state = window.__openclawTeamsCaptions as {
      droppedLines: number;
      lines: unknown[];
      visible: unknown[];
    };

    expect(state.lines).toHaveLength(0);
    expect(state.visible).toHaveLength(505);
    expect(state.droppedLines).toBe(0);
    expect(result.transcriptLines).toBe(505);
    const readTranscript = runInNewContext(
      `(${teamsMeetingTranscriptScript(URL, "session-1", false)})`,
      {
        URL: globalThis.URL,
        clearTimeout,
        document: {},
        location: new globalThis.URL(URL),
        window,
      },
    ) as () => string;
    const transcript = JSON.parse(readTranscript()) as { droppedLines: number; lines: unknown[] };
    expect(transcript.lines).toHaveLength(500);
    expect(transcript.droppedLines).toBe(5);
  });

  it("keeps repeated utterances from distinct caption rows", async () => {
    const first = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "Yes")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    const second = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "Yes")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: first.window.__openclawTeamsCaptions,
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });

    expect(second.result.transcriptLines).toBe(2);
  });

  it("keeps the latest caption when Teams shortens a provisional row", async () => {
    const row = captionRow("OpenClaw QA", "We should leave today");
    const first = await runStatusScript({
      allowMicrophone: false,
      captionRows: [row],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    const caption = row.querySelector('[data-tid="closed-caption-text"]');
    if (!caption) throw new Error("expected caption text control");
    caption.textContent = "We should leave";
    const second = await runStatusScript({
      allowMicrophone: false,
      captionRows: [row],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: first.window.__openclawTeamsCaptions,
    });

    expect(second.result.lastCaptionText).toBe("We should leave");
    expect(second.result.recentTranscript).toMatchObject([
      { speaker: "OpenClaw QA", text: "We should leave" },
    ]);
  });

  it("keeps a mid-sentence caption correction in the same row lifecycle", async () => {
    const row = captionRow("OpenClaw QA", "I like cats");
    const first = await runStatusScript({
      allowMicrophone: false,
      captionRows: [row],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    const caption = row.querySelector('[data-tid="closed-caption-text"]');
    if (!caption) throw new Error("expected caption text control");
    caption.textContent = "I liked cats";
    const second = await runStatusScript({
      allowMicrophone: false,
      captionRows: [row],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: first.window.__openclawTeamsCaptions,
    });

    expect(second.result.transcriptLines).toBe(1);
    expect(second.result.lastCaptionText).toBe("I liked cats");
  });

  it("updates a caption when its speaker label arrives late", async () => {
    const row = captionRow("", "Late attribution");
    const first = await runStatusScript({
      allowMicrophone: false,
      captionRows: [row],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    const author = row.querySelector('[data-tid="author"]');
    if (!author) throw new Error("expected caption author control");
    author.textContent = "OpenClaw QA";
    const second = await runStatusScript({
      allowMicrophone: false,
      captionRows: [row],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: first.window.__openclawTeamsCaptions,
    });

    expect(second.result.transcriptLines).toBe(1);
    expect(second.result.recentTranscript).toMatchObject([
      { speaker: "OpenClaw QA", text: "Late attribution" },
    ]);
  });

  it("disconnects stale caption capture outside transcribe mode", async () => {
    let disconnects = 0;
    const { window } = await runStatusScript({
      allowMicrophone: false,
      captureCaptions: false,
      leave: control({ label: "Leave" }),
      priorCaptions: {
        observer: { disconnect: () => (disconnects += 1) },
        observerInstalled: true,
      },
    });

    expect(disconnects).toBe(1);
    expect(window).not.toHaveProperty("__openclawTeamsCaptions");
  });

  it("does not clear captions owned by another tab or meeting session", async () => {
    let disconnects = 0;
    const active = {
      observer: { disconnect: () => (disconnects += 1) },
      observerInstalled: true,
      sessionId: "another-session",
    };
    const wrongTab = await runStatusScript({
      allowMicrophone: false,
      captureCaptions: false,
      currentUrl: "https://teams.live.com/v2/",
      leave: control({ label: "Leave" }),
      priorCaptions: active,
    });
    const wrongSession = await runStatusScript({
      allowMicrophone: false,
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: active,
    });

    expect(disconnects).toBe(0);
    expect(wrongTab.window.__openclawTeamsCaptions).toBe(active);
    expect(wrongSession.window.__openclawTeamsCaptions).toBe(active);
  });

  it("finalizes same-session captions when meeting identity is lost", async () => {
    let disconnects = 0;
    const currentUrl = "https://teams.live.com/v2/";
    const { window } = await runStatusScript({
      allowMicrophone: false,
      captureCaptions: true,
      currentUrl,
      leave: control({ label: "Leave" }),
      priorCaptions: {
        droppedLines: 0,
        epoch: "caption-epoch",
        lines: [],
        observer: { disconnect: () => (disconnects += 1) },
        observerInstalled: true,
        sessionId: "session-1",
        visible: [
          {
            at: "2026-07-17T12:00:00.000Z",
            speaker: "OpenClaw QA",
            text: "Preserve call-end captions",
          },
        ],
      },
    });
    const captions = window.__openclawTeamsCaptions as Record<string, unknown>;
    const readTranscript = runInNewContext(
      `(${teamsMeetingTranscriptScript(URL, "session-1", true)})`,
      {
        URL: globalThis.URL,
        clearTimeout,
        document: {},
        location: new globalThis.URL(currentUrl),
        window,
      },
    ) as () => string;
    const transcript = JSON.parse(readTranscript()) as { lines: Array<{ text: string }> };

    expect(disconnects).toBe(1);
    expect(captions.finalized).toBe(true);
    expect(transcript.lines).toMatchObject([{ text: "Preserve call-end captions" }]);
    expect(JSON.parse(readTranscript())).toMatchObject({
      lines: [{ text: "Preserve call-end captions" }],
    });
    expect(window.__openclawTeamsCaptions).toBe(captions);
  });

  it("finalizes caption capture before an SPA navigation can mix meetings", async () => {
    const params = {
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "Meeting A caption")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    };
    const page = await runStatusScript(params);

    params.captionRows = [captionRow("OpenClaw QA", "Meeting B caption")];
    page.triggerCaptionMutation(CONSUMER_URL);

    const captions = page.window.__openclawTeamsCaptions as {
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
    const readTranscript = runInNewContext(
      `(${teamsMeetingTranscriptScript(URL, "session-1", true)})`,
      {
        URL: globalThis.URL,
        clearTimeout,
        location: new globalThis.URL(CONSUMER_URL),
        window,
      },
    ) as () => string;

    expect(JSON.parse(readTranscript())).toMatchObject({
      urlMatched: true,
      sessionMatched: true,
      lines: [{ text: "Finalized before navigation" }],
    });
    expect(JSON.parse(readTranscript())).toMatchObject({
      lines: [{ text: "Finalized before navigation" }],
    });
    expect(window.__openclawTeamsCaptions).toBeDefined();
  });

  it("preserves same-session captions during the in-call rerender window", async () => {
    let disconnects = 0;
    const staleControl = control({ label: "Leave" });
    staleControl.isConnected = false;
    const active = {
      droppedLines: 0,
      enabledAttempted: true,
      lines: [],
      observer: { disconnect: () => (disconnects += 1) },
      observerInstalled: true,
      sessionId: "session-1",
      visible: [],
    };
    const currentUrl = "https://teams.live.com/v2/";
    const { window } = await runStatusScript({
      allowMicrophone: false,
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

    expect(disconnects).toBe(0);
    expect(window.__openclawTeamsCaptions).toBe(active);
  });

  it("keeps the live caption observer during a bounded in-call control rerender", async () => {
    const leave = control({ label: "Leave" });
    const currentUrl = "https://teams.live.com/v2/";
    const page = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "Caption before control rerender")],
      captureCaptions: true,
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
    expect(page.window.__openclawTeamsCaptions).not.toMatchObject({ finalized: true });
  });

  it("replaces finalized captions for a new verified session", async () => {
    const old = {
      droppedLines: 0,
      epoch: "old-epoch",
      finalized: true,
      lines: [{ text: "Old session" }],
      observerInstalled: false,
      sessionId: "old-session",
      visible: [],
    };
    const { window } = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "New session")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: old,
    });
    const current = window.__openclawTeamsCaptions as Record<string, unknown>;

    expect(current).not.toBe(old);
    expect(current.sessionId).toBe("session-1");
    expect(current.epoch).toBe("teams-caption-epoch");
  });

  it("rotates live captions when the verified tab adopts a new session", async () => {
    let disconnects = 0;
    const old = {
      droppedLines: 0,
      lines: [],
      observer: { disconnect: () => (disconnects += 1) },
      observerInstalled: true,
      sessionId: "old-session",
      visible: [{ text: "Old live caption" }],
    };
    const { window } = await runStatusScript({
      allowMicrophone: false,
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: old,
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "old-session",
      },
    });
    const current = window.__openclawTeamsCaptions as Record<string, unknown>;

    expect(disconnects).toBe(1);
    expect(old).toMatchObject({ finalized: true, lines: [{ text: "Old live caption" }] });
    expect(current).not.toBe(old);
    expect(current.sessionId).toBe("session-1");
    expect(window.__openclawTeamsCaptionArchive).toMatchObject({
      "old-session": old,
    });
    delete window.__openclawTeamsCaptions;

    const readOldTranscript = runInNewContext(
      `(${teamsMeetingTranscriptScript(URL, "old-session", false)})`,
      {
        URL: globalThis.URL,
        clearTimeout,
        location: new globalThis.URL(URL),
        window,
      },
    ) as () => string;
    expect(JSON.parse(readOldTranscript())).toMatchObject({
      sessionMatched: true,
      lines: [{ text: "Old live caption" }],
    });
  });

  it("disconnects caption capture when finalizing a transcript", async () => {
    const first = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "Final caption")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    let disconnects = 0;
    const captions = first.window.__openclawTeamsCaptions as Record<string, unknown>;
    captions.observer = { disconnect: () => (disconnects += 1) };
    captions.observerInstalled = true;
    const finalize = runInNewContext(`(${teamsMeetingTranscriptScript(URL, "session-1", true)})`, {
      URL: globalThis.URL,
      clearTimeout,
      document: {},
      location: new globalThis.URL(URL),
      window: first.window,
    }) as () => string;
    finalize();

    expect(disconnects).toBe(1);
    expect(captions.observerInstalled).toBe(false);
    expect(captions.identity).toBe("teams-work:19:meeting_test@thread.v2");

    const refreshed = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "Late caption")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: captions,
    });
    expect(refreshed.window.__openclawTeamsCaptions).toBe(captions);
    expect(captions.observerInstalled).toBe(false);
    expect(captions.lines).toMatchObject([{ text: "Final caption" }]);
  });

  it("enables caption capture only for transcribe mode and parses snapshots", () => {
    expect(TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.captions.enabled("agent")).toBe(false);
    expect(TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.captions.enabled("bidi")).toBe(false);
    expect(TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.captions.enabled("transcribe")).toBe(true);
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.captions.parseTranscript({
        result: JSON.stringify({
          droppedLines: 2,
          epoch: "caption-epoch",
          urlMatched: true,
          sessionMatched: true,
          lines: [
            {
              at: "2026-07-17T12:00:00.000Z",
              speaker: "OpenClaw QA",
              text: "Copper lantern validates Teams captions seven.",
            },
          ],
        }),
      }),
    ).toEqual({
      droppedLines: 2,
      epoch: "caption-epoch",
      lines: [
        {
          at: "2026-07-17T12:00:00.000Z",
          speaker: "OpenClaw QA",
          text: "Copper lantern validates Teams captions seven.",
        },
      ],
      urlMatched: true,
      sessionMatched: true,
    });
  });

  it("grants media permissions only to the exact Teams meeting origin", () => {
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.permissions({
        allowMicrophone: true,
        meetingUrl: URL,
      }),
    ).toEqual({
      origin: "https://teams.microsoft.com",
      permissions: ["audioCapture"],
      optionalPermissions: ["speakerSelection"],
    });
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.permissions({
        allowMicrophone: true,
        meetingUrl: "https://teams.live.com/meet/123?p=abc",
      }),
    ).toMatchObject({ origin: "https://teams.live.com" });
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.permissions({
        allowMicrophone: true,
        meetingUrl: "https://evil.example/meet/123",
      }),
    ).toBeUndefined();
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.permissionNotes({ allowMicrophone: true }),
    ).toContain("Granted Teams microphone permission through browser control.");
  });

  it("parses leave steps and malformed status", () => {
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.parseLeaveResult({
        result: JSON.stringify({ departed: false, leaveAction: "confirm", urlMatched: true }),
      }),
    ).toEqual({ departed: false, leaveAction: "confirm", urlMatched: true });
    expect(() =>
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.parseStatus({ result: "not-json" }),
    ).toThrow("Microsoft Teams browser status JSON is malformed.");
  });
});
