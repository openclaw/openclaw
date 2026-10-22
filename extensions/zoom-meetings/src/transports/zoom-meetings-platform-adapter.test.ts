import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { zoomMeetingPageScripts } from "./zoom-meetings-page-scripts.js";
import { ZOOM_MEETINGS_PLATFORM_ADAPTER } from "./zoom-meetings-platform-adapter.js";

const URL = "https://acme.zoom.us/j/12345678901?pwd=abc";
const browser = ZOOM_MEETINGS_PLATFORM_ADAPTER.browser;
const inCallUrl = "https://app.zoom.us/wc/12345678901/join";

function ownedWindow(state: Record<string, unknown> = {}) {
  return {
    __openclawZoomMeeting: { identity: "zoom:12345678901", sessionId: "session-1", ...state },
  };
}

it.each([true, false])(
  "starts browser capture only for the current Zoom session (owner=%s)",
  async (owns) => {
    const source = browser.buildAudioCaptureScript?.({
      action: "start",
      captureId: "capture-1",
      meetingSessionId: "session-1",
      meetingUrl: URL,
    });
    const identity = ZOOM_MEETINGS_PLATFORM_ADAPTER.urls.normalizeForReuse(URL);
    const result = runInNewContext(`(${source})()`, {
      URL: globalThis.URL,
      location: { href: URL },
      window: { __openclawZoomMeeting: { sessionId: owns ? "session-1" : "session-2", identity } },
      AudioContext: function AudioContext() {
        throw new Error("capture admitted");
      },
    });
    await expect(result).rejects.toThrow(owns ? "capture admitted" : "no longer owns");
  },
);

function pageControl(label: string, toggledLabel?: string) {
  const click = vi.fn();
  const control = {
    disabled: false,
    isConnected: true,
    textContent: label,
    click,
    closest: () => control,
    getAttribute: (name: string) =>
      name === "aria-label" ? (toggledLabel ? control.textContent : label) : null,
    matches: (selector: string) => selector === "button",
    querySelector: () => undefined,
    querySelectorAll: () => [],
  };
  if (toggledLabel) {
    click.mockImplementation(() => {
      control.textContent = toggledLabel;
    });
  }
  return control;
}

type Control = ReturnType<typeof pageControl>;
function statusDocument(params: {
  bodyText?: string;
  camera?: Control;
  challenge?: Control;
  devicePrompt?: Control;
  join?: Control;
  kind?: string;
  leave?: Control;
  microphone?: Control;
}) {
  const { camera, challenge, devicePrompt, join, leave, microphone, kind } = params;
  const controls = [camera, challenge, devicePrompt, join, leave, microphone].filter(
    (control): control is Control => Boolean(control),
  );
  return {
    body: { textContent: params.bodyText ?? "" },
    title: "Zoom",
    querySelector(selector: string) {
      const matches = (...parts: string[]) => parts.some((part) => selector.includes(part));
      const rules: [boolean, Control | undefined][] = [
        [matches("preview-join-button"), join],
        [matches('aria-label="Leave"'), leave],
        [matches("preview-video-control-button", "send-video"), camera],
        [
          matches("preview-audio-control-button", "mute my microphone", "unmute my microphone"),
          microphone,
        ],
        [kind === "passcode" && matches("password", "passcode"), challenge],
        [kind === "captcha" && matches("recaptcha", "captcha", "data-sitekey"), challenge],
      ];
      return rules.find(([matched]) => matched)?.[1];
    },
    querySelectorAll: (selector: string) =>
      selector === "button" || selector.includes('[role="button"]') ? controls : [],
  };
}

function inCallDocument(overrides: Parameters<typeof statusDocument>[0] = {}) {
  return statusDocument({
    camera: pageControl("Start Video"),
    leave: pageControl("Leave"),
    microphone: pageControl("Unmute my microphone"),
    ...overrides,
  });
}

function pageContext(document: object, currentUrl = URL, window: Record<string, unknown> = {}) {
  return { URL: globalThis.URL, document, location: new globalThis.URL(currentUrl), window };
}

async function runStatusFixture(params: {
  allowMicrophone?: boolean;
  currentUrl?: string;
  document: ReturnType<typeof statusDocument>;
  navigator?: Record<string, unknown>;
  readOnly?: boolean;
  window?: Record<string, unknown>;
}) {
  const result = await runInNewContext(
    `(${zoomMeetingPageScripts.status({
      allowMicrophone: params.allowMicrophone ?? false,
      allowSessionAdoption: true,
      autoJoin: true,
      captureCaptions: false,
      guestName: "OpenClaw Agent",
      meetingSessionId: "session-1",
      meetingUrl: URL,
      readOnly: params.readOnly,
      waitForInCallMs: 60_000,
    })})()`,
    {
      ...pageContext(params.document, params.currentUrl, params.window),
      navigator: params.navigator ?? {},
      setTimeout,
    },
  );
  return JSON.parse(result) as Record<string, unknown>;
}

function runLeaveFixture(params: {
  document: object;
  currentUrl?: string;
  leaveInitiated?: boolean;
  window?: Record<string, unknown>;
}) {
  return JSON.parse(
    runInNewContext(
      `(${zoomMeetingPageScripts.leave({
        leaveInitiated: params.leaveInitiated ?? false,
        meetingSessionId: "session-1",
        meetingUrl: URL,
      })})()`,
      pageContext(params.document, params.currentUrl, params.window),
    ),
  );
}

function runAudioInputFixture(deviceLabel: string, window?: Record<string, unknown>) {
  return runStatusFixture({
    allowMicrophone: true,
    document: inCallDocument({ microphone: pageControl("Mute my microphone") }),
    navigator: {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [
          { deviceId: "virtual-input", kind: "audioinput", label: deviceLabel },
        ]),
      },
    },
    readOnly: true,
    window,
  });
}

function status(reason: string) {
  const health = browser.parseStatus({
    result: JSON.stringify({
      inCall: false,
      manualAction: { reason, message: "manual action" },
      url: URL,
    }),
  });
  if (!health) {
    throw new Error("expected parsed health");
  }
  return health;
}

describe("Zoom meeting platform adapter", () => {
  it("classifies Zoom session conflicts", () => {
    const reason = "zoom-session-conflict";
    expect(browser.classifyManualAction(status(reason))).toEqual({
      category: "session-conflict",
      reason,
      message: "manual action",
    });
  });

  it("grants microphone and optional output routing on the Zoom Web App origin", () => {
    expect(browser.permissions({ allowMicrophone: true, meetingUrl: URL })).toEqual({
      origin: "https://app.zoom.us",
      permissions: ["audioCapture"],
      optionalPermissions: ["speakerSelection"],
    });
    expect(browser.permissions({ allowMicrophone: false, meetingUrl: URL })).toBeUndefined();
  });

  it("recognizes the Zoom Web App home redirect as completed leave", () => {
    const result = runLeaveFixture({
      document: statusDocument({ bodyText: "Join Meeting" }),
      leaveInitiated: true,
      currentUrl: "https://app.zoom.us/wc?ref_from=waffle_zwa",
      window: ownedWindow(),
    });
    expect(result).toEqual({ departed: true, sessionMatched: true, urlMatched: true });
  });

  it("does not treat a live Web App home page or meeting text as post-call", () => {
    const leave = pageControl("Leave");
    const document = {
      body: { textContent: "Someone said the meeting has ended" },
      querySelector: (selector: string) =>
        selector.includes('aria-label="Leave"') ? leave : undefined,
      querySelectorAll: (selector: string) =>
        selector === "button"
          ? [leave]
          : selector.includes("main")
            ? [{ textContent: "Someone said the meeting has ended" }]
            : [],
    };
    const result = runLeaveFixture({
      document,
      currentUrl: "https://app.zoom.us/wc",
      window: ownedWindow({ inCallControl: leave, inCallUrl: "https://app.zoom.us/wc" }),
    });
    expect(result).toMatchObject({ departed: false, leaveAction: "leave" });
    expect(leave.click).toHaveBeenCalledOnce();
  });

  it("re-adopts a verified meeting URL after a full document reload before leaving", () => {
    const leave = pageControl("Leave");
    const window: Record<string, unknown> = {};
    const result = runLeaveFixture({ document: statusDocument({ leave }), window });
    expect(result).toMatchObject({ leaveAction: "leave", urlMatched: true });
    expect(leave.click).toHaveBeenCalledOnce();
    expect(window).toMatchObject({
      __openclawZoomMeeting: { identity: "zoom:12345678901", sessionId: "session-1" },
    });
  });

  it.each([
    { bodyText: "Enter meeting passcode", kind: "passcode", reason: "zoom-passcode-required" },
    { bodyText: "Security check", kind: "captcha", reason: "zoom-captcha-required" },
  ])("reports a $kind challenge before camera gating", async ({ bodyText, kind, reason }) => {
    const join = pageControl("Join");
    const challenge = pageControl(kind === "passcode" ? "Meeting passcode" : "CAPTCHA");
    const result = await runStatusFixture({
      document: statusDocument({ bodyText, challenge, join, kind }),
    });
    expect(result).toMatchObject({ clickedJoin: false, manualAction: { reason } });
    expect(join.click).not.toHaveBeenCalled();
  });

  it("persists Zoom's confirmed no-device state for observe-only joins", async () => {
    const window: Record<string, unknown> = {};
    const devicePrompt = pageControl("Continue without audio or video");
    devicePrompt.click.mockImplementation(() => {
      devicePrompt.disabled = true;
    });
    const first = await runStatusFixture({
      document: statusDocument({ devicePrompt, join: pageControl("Join") }),
      window,
    });
    const second = await runStatusFixture({
      document: statusDocument({ join: pageControl("Join") }),
      readOnly: true,
      window,
    });
    expect(devicePrompt.click).toHaveBeenCalled();
    expect(first.manualAction).toBeUndefined();
    expect(first).toMatchObject({ cameraOff: true, clickedJoin: true, micMuted: true });
    expect(second).toMatchObject({ cameraOff: true, micMuted: true });
    expect(window["__openclawZoomMeeting"]).toMatchObject({ devicesDisabled: true });
  });

  it("re-mutes an observe-only session after admission", async () => {
    const microphone = pageControl("Mute my microphone", "Unmute my microphone");
    const result = await runStatusFixture({ document: inCallDocument({ microphone }) });
    expect(result).toMatchObject({ inCall: true, micMuted: true });
    expect(result.manualAction).toBeUndefined();
    expect(microphone.click).toHaveBeenCalledOnce();
  });

  it("fails closed when an in-call observe-only microphone cannot be verified", async () => {
    const result = await runStatusFixture({ document: inCallDocument({ microphone: undefined }) });
    expect(result).toMatchObject({
      inCall: true,
      manualAction: { reason: "zoom-microphone-required" },
    });
  });

  it("turns off an adopted in-call camera", async () => {
    const camera = pageControl("Stop Video", "Start Video");
    const result = await runStatusFixture({ document: inCallDocument({ camera }) });
    expect(result).toMatchObject({ cameraOff: true, inCall: true });
    expect(result.manualAction).toBeUndefined();
    expect(camera.click).toHaveBeenCalledOnce();
  });

  it("fails closed when an adopted in-call camera cannot be verified", async () => {
    const result = await runStatusFixture({ document: inCallDocument({ camera: undefined }) });
    expect(result).toMatchObject({
      inCall: true,
      manualAction: { reason: "zoom-camera-required" },
    });
  });

  it("marks a previously verified call ended after its control stays gone", async () => {
    const result = await runStatusFixture({
      currentUrl: "https://app.zoom.us/wc",
      document: statusDocument({}),
      window: ownedWindow({
        inCallControl: { isConnected: false },
        inCallControlLostAt: Date.now() - 6_000,
        inCallUrl,
        verifiedAt: Date.now() - 6_000,
      }),
    });
    expect(result).toMatchObject({ inCall: false, meetingEnded: true });
  });

  it("re-adopts a replacement Leave control after a late Zoom rerender", async () => {
    const result = await runStatusFixture({
      currentUrl: inCallUrl,
      document: inCallDocument(),
      readOnly: true,
      window: ownedWindow({
        inCallControl: { isConnected: false },
        inCallUrl,
        verifiedAt: Date.now() - 60_000,
      }),
    });
    expect(result).toMatchObject({ inCall: true, meetingEnded: false });
  });

  it("does not trust a cached BlackHole device after Zoom hides its current selection", async () => {
    const meetingState = {
      audioInputDeviceId: "virtual-input",
      identity: "zoom:12345678901",
      sessionId: "session-1",
    };
    const result = await runAudioInputFixture("BlackHole 2ch", {
      __openclawZoomMeeting: meetingState,
    });
    expect(result).toMatchObject({
      audioInputDeviceLabel: "BlackHole 2ch",
      audioInputRouted: false,
      manualAction: {
        message:
          "Verify the OpenClaw virtual audio device is selected as both the Zoom microphone and speaker before starting talk-back.",
        reason: "zoom-audio-choice-required",
      },
    });
    expect(meetingState).not.toHaveProperty("audioInputDeviceId");
  });

  it("rejects the non-contract virtual audio input label", async () => {
    const result = await runAudioInputFixture("OpenClaw Meeting Audio (Virtual)");
    expect(result).not.toHaveProperty("audioInputDeviceLabel");
    expect(result).toMatchObject({
      audioInputRouted: false,
      manualAction: { reason: "zoom-audio-choice-required" },
    });
  });

  it("retains meeting ownership through an unbounded lobby wait", async () => {
    const window: Record<string, unknown> = {};
    const waiting = await runStatusFixture({
      document: statusDocument({ bodyText: "The host will let you in soon" }),
      window,
    });
    const marker = window["__openclawZoomMeeting"] as Record<string, unknown>;
    marker.verifiedAt = 0;
    const admitted = await runStatusFixture({
      currentUrl: "https://app.zoom.us/wc",
      document: inCallDocument({ camera: undefined }),
      window,
    });
    expect(waiting).toMatchObject({
      lobbyWaiting: true,
      manualAction: { reason: "zoom-admission-required" },
    });
    expect(admitted).toMatchObject({ inCall: true, micMuted: true });
    expect(window["__openclawZoomMeeting"]).toMatchObject({
      awaitingAdmission: false,
      identity: "zoom:12345678901",
      sessionId: "session-1",
    });
  });
});
