import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { zoomMeetingPageScripts } from "./zoom-meetings-page-scripts.js";
import { ZOOM_MEETINGS_PLATFORM_ADAPTER } from "./zoom-meetings-platform-adapter.js";

const URL = "https://acme.zoom.us/j/12345678901?pwd=abc";
const browser = ZOOM_MEETINGS_PLATFORM_ADAPTER.browser;
const inCallUrl = "https://app.zoom.us/wc/12345678901/join";
const session = { meetingSessionId: "session-1", meetingUrl: URL };
const owner = { identity: "zoom:12345678901", sessionId: session.meetingSessionId };

const ownedWindow = (state: Record<string, unknown> = {}) => ({
  __openclawZoomMeeting: { ...owner, ...state },
});

it.each([true, false])(
  "starts browser capture only for the current Zoom session (owner=%s)",
  async (owns) => {
    const source = browser.buildAudioCaptureScript?.({
      action: "start",
      captureId: "capture-1",
      ...session,
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
  const control = {
    disabled: false,
    isConnected: true,
    textContent: label,
    click: vi.fn(() => {
      if (toggledLabel) {
        control.textContent = toggledLabel;
      }
    }),
    getAttribute: (name: string) => (name === "aria-label" ? control.textContent : null),
    matches: (selector: string) => selector === "button",
  };
  return control;
}

type Control = ReturnType<typeof pageControl>;
type ControlName = "camera" | "challenge" | "devicePrompt" | "join" | "leave" | "microphone";
type Controls = Partial<Record<ControlName, Control>> & { bodyText?: string; kind?: string };
function statusDocument(params: Controls) {
  const { camera, challenge, devicePrompt, join, leave, microphone, kind } = params;
  const controls = [camera, challenge, devicePrompt, join, leave, microphone].filter(
    (control): control is Control => Boolean(control),
  );
  const rules: [RegExp, Control | undefined][] = [
    [/preview-join-button/, join],
    [/aria-label="Leave"/, leave],
    [/preview-video-control-button|send-video/, camera],
    [/preview-audio-control-button|(?:un)?mute my microphone/, microphone],
    [/password|passcode/, kind === "passcode" ? challenge : undefined],
    [/recaptcha|captcha|data-sitekey/, kind === "captcha" ? challenge : undefined],
  ];
  return {
    body: { textContent: params.bodyText ?? "" },
    title: "Zoom",
    querySelector: (selector: string) => rules.find(([pattern]) => pattern.test(selector))?.[1],
    querySelectorAll: (selector: string) =>
      selector === "button" || selector.includes('[role="button"]') ? controls : [],
  };
}

function inCallDocument(overrides: Controls = {}) {
  return statusDocument({
    camera: pageControl("Start Video"),
    leave: pageControl("Leave"),
    microphone: pageControl("Unmute my microphone"),
    ...overrides,
  });
}

type Page = {
  document: object;
  currentUrl?: string;
  window?: Record<string, unknown>;
  navigator?: Record<string, unknown>;
  allowMicrophone?: boolean;
  readOnly?: boolean;
};
function runPageScript(source: string, page: Page) {
  return runInNewContext(`(${source})()`, {
    URL: globalThis.URL,
    document: page.document,
    location: new globalThis.URL(page.currentUrl ?? URL),
    window: page.window ?? {},
    navigator: page.navigator ?? {},
    setTimeout,
  });
}

async function runStatusFixture(params: Page & { document: ReturnType<typeof statusDocument> }) {
  const result = await runPageScript(
    zoomMeetingPageScripts.status({
      allowMicrophone: params.allowMicrophone ?? false,
      allowSessionAdoption: true,
      autoJoin: true,
      captureCaptions: false,
      guestName: "OpenClaw Agent",
      ...session,
      readOnly: params.readOnly,
      waitForInCallMs: 60_000,
    }),
    params,
  );
  return JSON.parse(result) as Record<string, unknown>;
}

it("classifies Zoom session conflicts", () => {
  const manualAction = { reason: "zoom-session-conflict", message: "manual action" };
  const health = browser.parseStatus({
    result: JSON.stringify({ inCall: false, manualAction, url: URL }),
  });
  expect(health && browser.classifyManualAction(health)).toEqual({
    category: "session-conflict",
    ...manualAction,
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

it.each([
  ["home redirect", "https://app.zoom.us/wc?ref_from=waffle_zwa", true],
  ["live home page", "https://app.zoom.us/wc", false],
  ["document reload", URL, false],
] as const)("leaves after %s", (_scenario, currentUrl, redirected) => {
  const reloaded = currentUrl === URL;
  const leave = redirected ? undefined : pageControl("Leave");
  const window: Record<string, unknown> = reloaded
    ? {}
    : ownedWindow({ inCallControl: leave, inCallUrl: currentUrl });
  const bodyText = redirected ? "Join Meeting" : "Someone said the meeting has ended";
  const document = statusDocument({ bodyText, leave });
  const source = zoomMeetingPageScripts.leave({ ...session, leaveInitiated: redirected });
  const result = JSON.parse(
    runPageScript(source, {
      document: {
        ...document,
        querySelectorAll: (selector: string) =>
          selector.includes("main")
            ? [{ textContent: bodyText }]
            : document.querySelectorAll(selector),
      },
      currentUrl,
      window,
    }),
  );
  if (redirected) {
    expect(result).toEqual({ departed: true, sessionMatched: true, urlMatched: true });
  } else {
    expect(result).toMatchObject({ departed: false, leaveAction: "leave", urlMatched: true });
    expect(leave?.click).toHaveBeenCalledOnce();
    expect(window["__openclawZoomMeeting"]).toMatchObject(owner);
  }
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
});

it.each([
  ["microphone", "Mute my microphone", "Unmute my microphone", "micMuted"],
  ["camera", "Stop Video", "Start Video", "cameraOff"],
  ["microphone", undefined, undefined, "micMuted"],
  ["camera", undefined, undefined, "cameraOff"],
] as const)("enforces in-call %s safety with control %s", async (kind, on, off, field) => {
  const control = on ? pageControl(on, off) : undefined;
  const result = await runStatusFixture({ document: inCallDocument({ [kind]: control }) });
  expect(result.inCall).toBe(true);
  if (control) {
    expect(result[field]).toBe(true);
    expect(result.manualAction).toBeUndefined();
    expect(control.click).toHaveBeenCalledOnce();
  } else {
    expect(result.manualAction).toMatchObject({ reason: `zoom-${kind}-required` });
  }
});

it.each([false, true])("handles lost call controls (replacement=%s)", async (replacement) => {
  const result = await runStatusFixture({
    currentUrl: replacement ? inCallUrl : "https://app.zoom.us/wc",
    document: replacement ? inCallDocument() : statusDocument({}),
    readOnly: replacement ? true : undefined,
    window: ownedWindow({
      inCallControl: { isConnected: false },
      inCallControlLostAt: replacement ? undefined : Date.now() - 6_000,
      inCallUrl,
      verifiedAt: Date.now() - (replacement ? 60_000 : 6_000),
    }),
  });
  expect(result).toMatchObject({ inCall: replacement, meetingEnded: !replacement });
});

it.each(["BlackHole 2ch", "OpenClaw Meeting Audio (Virtual)"])(
  "requires a verified audio selection for %s",
  async (label) => {
    const recognized = label === "BlackHole 2ch";
    const window = ownedWindow({ audioInputDeviceId: "virtual-input" });
    const meetingState = window["__openclawZoomMeeting"];
    const result = await runStatusFixture({
      allowMicrophone: true,
      document: inCallDocument({ microphone: pageControl("Mute my microphone") }),
      navigator: {
        mediaDevices: {
          enumerateDevices: vi.fn(async () => [
            { deviceId: "virtual-input", kind: "audioinput", label },
          ]),
        },
      },
      readOnly: true,
      window: recognized ? window : undefined,
    });
    expect(result).toMatchObject({
      audioInputRouted: false,
      manualAction: { reason: "zoom-audio-choice-required" },
    });
    if (recognized) {
      expect(result.audioInputDeviceLabel).toBe(label);
      expect(meetingState).not.toHaveProperty("audioInputDeviceId");
    } else {
      expect(result).not.toHaveProperty("audioInputDeviceLabel");
    }
  },
);

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
    ...owner,
  });
});
