import { runInNewContext } from "node:vm";
import { teamsMeetingPageScripts } from "./teams-meetings-page-scripts.js";

export const URL =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_test%40thread.v2/0?context=%7b%7d";
export const CONSUMER_URL = "https://teams.live.com/meet/9326458712345?p=abc";
export const MEETING_STATE_KEY = "__openclawTeamsMeeting";
export const AUDIO_OUTPUTS = "__openclawTeamsAudioOutputs";
export const MEETING_IDENTITY = "teams-work:19:meeting_test@thread.v2";
export const meetingOwner = (overrides: Record<string, unknown> = {}) => ({
  identity: MEETING_IDENTITY,
  sessionId: "session-1",
  ...overrides,
});
export const blackholeDevice = (kind: "input" | "output") => ({
  deviceId: `blackhole-${kind}`,
  kind: `audio${kind}`,
  label: "BlackHole 2ch",
});

export function consumerLightMeetingUrl(meetingCode: string, passcode: string) {
  const coordinates = btoa(JSON.stringify({ meetingCode, passcode }));
  return `https://teams.live.com/light-meetings/launch?coords=${encodeURIComponent(coordinates)}`;
}

type PageControl = {
  checked?: boolean;
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

export type PageMedia = {
  autoplay?: boolean;
  currentSrc?: string;
  isConnected?: boolean;
  muted?: boolean;
  readyState?: number;
  sinkId: string;
  srcObject?: { getAudioTracks(): Array<{ readyState: string }> };
  play?(): Promise<void>;
  pause?(): void;
  remove?(): void;
  setSinkId(value: string): Promise<void>;
};

export const liveMediaStream = () => ({ getAudioTracks: () => [{ readyState: "live" }] });

export function pageMedia(params: Partial<PageMedia> = {}): PageMedia {
  const media: PageMedia = {
    ...params,
    sinkId: params.sinkId ?? "",
    setSinkId:
      params.setSinkId ??
      (async (value) => {
        media.sinkId = value;
      }),
  };
  return media;
}

export function abortingMedia(message: string, params: Partial<PageMedia> = {}) {
  return pageMedia({
    ...params,
    async setSinkId() {
      throw new DOMException(message, "AbortError");
    },
  });
}

export function control(params: {
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

export const toggleOff = (kind: "camera" | "microphone") =>
  control({ label: `Turn ${kind} off`, pressed: true, onClick: (node) => node.setPressed(false) });

export const audioEntry = (
  source: object,
  bridge: object,
  extra: Record<string, unknown> = {},
) => ({ bridge, sessionId: "session-1", source, sourceMuted: false, ...extra });

function findControl(
  selector: string | undefined,
  entries: Record<string, PageControl | undefined>,
) {
  return Object.entries(entries).find(([needles]) =>
    needles.split("|").some((needle) => selector?.includes(needle)),
  )?.[1];
}

export function captionRow(speaker: string, text: string, rowIdentity?: string): PageControl {
  const author = control({ label: "", text: speaker });
  const content = control({ label: "", text });
  const row = control({ label: "" });
  const getAttribute = row.getAttribute.bind(row);
  row.getAttribute = (name) =>
    name === "aria-posinset" && rowIdentity ? rowIdentity : getAttribute(name);
  row.querySelector = (selector) =>
    findControl(selector, {
      'data-tid="author"': author,
      'data-tid="closed-caption-text"': content,
    });
  return row;
}

type StatusScriptParams = Partial<
  Record<"allowMicrophone" | "allowSessionAdoption" | "autoJoin" | "readOnly", boolean> &
    Record<"captionClickIgnored" | "captionsInitiallyOn" | "captureCaptions", boolean> &
    Record<"bodyText" | "currentUrl" | "meetingUrl" | "meetingSessionId", string> &
    Record<"microphone" | "camera" | "join" | "leave" | "permissionPrompt", PageControl> &
    Record<"continueWithoutDevices" | "deviceSettings" | "globalSelectedOption", PageControl> &
    Record<
      "microphoneDevice" | "microphoneDeviceAfterSettings" | "microphoneDeviceMenuAfterSettings",
      PageControl
    > & {
      captionRows: PageControl[];
      bridgeMedia: PageMedia;
      microphonePermissionState: "denied" | "granted" | "prompt";
      priorAudioOutputs: unknown[];
      priorCaptions: unknown;
      priorMeeting: Record<string, unknown>;
      waitForInCallMs: number;
      media: PageMedia[];
      devices: Array<{ deviceId: string; kind: string; label: string }>;
    }
>;

function priorWindow(params: StatusScriptParams): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      [MEETING_STATE_KEY]: params.priorMeeting,
      __openclawTeamsAudioOutputs: params.priorAudioOutputs,
      __openclawTeamsCaptions: params.priorCaptions,
    }).filter(([, value]) => Boolean(value)),
  );
}

export async function runStatusScript(params: StatusScriptParams) {
  const location = new globalThis.URL(params.currentUrl ?? URL);
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
      if (!params.captionClickIgnored) {
        captionsOn = true;
      }
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
  const document = {
    body,
    createElement() {
      if (!params.bridgeMedia) {
        throw new Error("unexpected media bridge");
      }
      return params.bridgeMedia;
    },
    title: "Teams",
    querySelector(selector: string) {
      if (selector === '[role="option"][aria-selected="true"]') {
        return params.globalSelectedOption;
      }
      const selected = params.deviceSettings?.clicks
        ? (params.microphoneDeviceAfterSettings ?? params.microphoneDevice)
        : params.microphoneDevice;
      const menu = params.deviceSettings?.clicks
        ? (params.microphoneDeviceMenuAfterSettings ?? params.microphoneDeviceAfterSettings)
        : undefined;
      const captionsVisible = params.captionRows && captionsOn;
      return findControl(selector, {
        "toggle-mute": params.microphone,
        "toggle-video": params.camera,
        "prejoin-join-button": params.join,
        "call-hangup|hangup-button": params.leave,
        More: params.captionRows ? moreActions : undefined,
        "closed-captions-button|title*=":
          params.captionRows && captionMenuOpen ? captionButton : undefined,
        "closed-caption-renderer-wrapper": captionsVisible ? captionRenderer : undefined,
        "closed-caption-v2-virtual-list-content": captionsVisible ? captionContent : undefined,
        "audio-button-configure|Open audio options|device-settings-button": params.deviceSettings,
        "selected-microphone-display|microphone-select|audio-device-input|device-settings-microphone":
          selected,
        "microphone-settings": menu,
        "permission-prompt|permission-error": params.permissionPrompt,
      });
    },
    querySelectorAll(selector: string) {
      return selector === "button"
        ? controls
        : selector === "audio, video"
          ? (params.media ?? [])
          : selector.includes('[role="option"]') && params.globalSelectedOption
            ? [params.globalSelectedOption]
            : [];
    },
  };
  const window = priorWindow(params);
  let captionObserverCallback:
    | ((records?: Array<{ removedNodes: PageControl[] }>) => void)
    | undefined;
  let captionObserverDisconnects = 0;
  const script = teamsMeetingPageScripts.status({
    allowMicrophone: params.allowMicrophone ?? false,
    allowSessionAdoption: params.allowSessionAdoption ?? true,
    autoJoin: params.autoJoin ?? true,
    captureCaptions: params.captureCaptions ?? false,
    guestName: "OpenClaw Guest",
    meetingSessionId: params.meetingSessionId === undefined ? "session-1" : params.meetingSessionId,
    meetingUrl: params.meetingUrl ?? URL,
    readOnly: params.readOnly,
    waitForInCallMs: params.waitForInCallMs ?? 60_000,
  });
  const run = runInNewContext(`(${script})`, {
    MutationObserver: class MutationObserver {
      constructor(callback: (records?: Array<{ removedNodes: PageControl[] }>) => void) {
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
      mediaDevices: { enumerateDevices: async () => params.devices ?? [] },
      permissions: { query: async () => ({ state: params.microphonePermissionState ?? "prompt" }) },
    },
    clearTimeout,
    setTimeout,
    window,
  }) as () => Promise<string>;
  return {
    captionButton,
    captionObserverDisconnects: () => captionObserverDisconnects,
    triggerCaptionMutation(nextUrl?: string, removedNode?: PageControl) {
      if (nextUrl) {
        location.href = nextUrl;
      }
      captionObserverCallback?.(removedNode ? [{ removedNodes: [removedNode] }] : []);
    },
    result: JSON.parse(await run()) as Record<string, unknown>,
    window,
  };
}

type StatusOverrides = Omit<StatusScriptParams, "allowMicrophone">;

export function runCaptionStatusScript(params: StatusOverrides = {}) {
  return runStatusScript({
    captureCaptions: true,
    leave: control({ label: "Leave" }),
    ...params,
  });
}

type StatusScriptPage = Awaited<ReturnType<typeof runStatusScript>>;

export function continueStatusScript(previous: StatusScriptPage, params: StatusScriptParams = {}) {
  return runStatusScript({
    ...params,
    priorAudioOutputs: previous.window["__openclawTeamsAudioOutputs"] as unknown[],
    priorMeeting: previous.window[MEETING_STATE_KEY] as Record<string, unknown>,
  });
}

export function runCaptionRows(
  captionRows: PageControl[],
  previous?: StatusScriptPage,
  params: StatusOverrides = {},
) {
  return runCaptionStatusScript({
    captionRows,
    priorCaptions: previous?.window["__openclawTeamsCaptions"],
    ...params,
  });
}

export function runAudioStatusScript(params: StatusOverrides = {}) {
  return runStatusScript(audioStatusParams(params));
}

export function audioStatusParams(params: StatusOverrides = {}): StatusScriptParams {
  return {
    allowMicrophone: true,
    devices: [blackholeDevice("input"), blackholeDevice("output")],
    leave: control({ label: "Leave" }),
    microphone: control({ label: "Turn microphone off", pressed: true }),
    microphoneDevice: control({ label: "BlackHole 2ch" }),
    priorMeeting: { identity: MEETING_IDENTITY },
    ...params,
  };
}

export function runLeaveScript(params: {
  bodyText?: string;
  currentUrl?: string;
  leave?: PageControl;
  leaveInitiated?: boolean;
  meetingSessionId?: string;
  omitMeetingState?: boolean;
  postCall?: PageControl;
  priorAudioOutputs?: unknown[];
  priorMeeting?: Record<string, unknown>;
}) {
  const currentUrl = params.currentUrl ?? URL;
  const location = new globalThis.URL(currentUrl);
  const document = {
    body: { textContent: params.bodyText ?? "" },
    querySelector(selector: string) {
      return findControl(selector, {
        "call-hangup": params.leave,
        "call-ended-screen|post-call-screen|prejoin-rejoin-button": params.postCall,
      });
    },
  };
  const window = priorWindow({ priorAudioOutputs: params.priorAudioOutputs });
  if (!params.omitMeetingState) {
    window[MEETING_STATE_KEY] = {
      sessionId: params.meetingSessionId ?? "session-1",
      ...params.priorMeeting,
    };
  }
  const run = runInNewContext(
    `(${teamsMeetingPageScripts.leave({ leaveInitiated: params.leaveInitiated ?? false, meetingSessionId: params.meetingSessionId ?? "session-1", meetingUrl: URL })})`,
    { URL: globalThis.URL, document, location, window },
  ) as () => string;
  return { result: JSON.parse(run()) as Record<string, unknown>, window };
}
