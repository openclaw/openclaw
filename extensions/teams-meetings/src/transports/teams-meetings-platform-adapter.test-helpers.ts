import { runInNewContext } from "node:vm";
import { teamsMeetingPageScripts } from "./teams-meetings-page-scripts.js";
import { TEAMS_MEETINGS_PLATFORM_ADAPTER } from "./teams-meetings-platform-adapter.js";

export const URL =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_test%40thread.v2/0?context=%7b%7d";
export const CONSUMER_URL = "https://teams.live.com/meet/9326458712345?p=abc";
export const MEETING_STATE_KEY = "__openclawTeamsMeeting";

export function consumerLightMeetingUrl(meetingCode: string, passcode: string) {
  const coordinates = btoa(JSON.stringify({ meetingCode, passcode }));
  return `https://teams.live.com/light-meetings/launch?coords=${encodeURIComponent(coordinates)}`;
}

export function status(reason: string, message = "manual action") {
  const health = TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.parseStatus({
    result: JSON.stringify({
      inCall: false,
      manualAction: { reason, message },
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

export type PageMedia = {
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

export function captionRow(
  speaker: string,
  captionText: string,
  rowIdentity?: string,
): PageControl {
  const author = control({ label: "", text: speaker });
  const content = control({ label: "", text: captionText });
  const row = control({ label: "" });
  const getAttribute = row.getAttribute.bind(row);
  row.getAttribute = (name) =>
    name === "aria-posinset" && rowIdentity ? rowIdentity : getAttribute(name);
  row.querySelector = (selector) => {
    if (selector?.includes('data-tid="author"')) {
      return author;
    }
    if (selector?.includes('data-tid="closed-caption-text"')) {
      return content;
    }
    return undefined;
  };
  return row;
}

type StatusScriptParams = {
  allowMicrophone?: boolean;
  allowSessionAdoption?: boolean;
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
  waitForInCallMs?: number;
  globalSelectedOption?: PageControl;
  media?: PageMedia[];
  meetingSessionId?: string;
  devices?: Array<{ deviceId: string; kind: string; label: string }>;
};

export async function runStatusScript(params: StatusScriptParams) {
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
  let bridgeMediaIndex = 0;
  const document = {
    body,
    createElement() {
      if (!params.bridgeMedia) {
        throw new Error("unexpected media bridge");
      }
      if (!Array.isArray(params.bridgeMedia)) {
        return params.bridgeMedia;
      }
      const bridge = params.bridgeMedia[bridgeMediaIndex++];
      if (!bridge) {
        throw new Error("missing media bridge fixture");
      }
      return bridge;
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
      const matches: Array<[string, PageControl | undefined]> = [
        ["toggle-mute", params.microphone],
        ["toggle-video", params.camera],
        ["prejoin-join-button", params.join],
        ["call-hangup|hangup-button", params.leave],
        ["More", params.captionRows ? moreActions : undefined],
        [
          "closed-captions-button|title*=",
          params.captionRows && captionMenuOpen ? captionButton : undefined,
        ],
        ["closed-caption-renderer-wrapper", captionsVisible ? captionRenderer : undefined],
        ["closed-caption-v2-virtual-list-content", captionsVisible ? captionContent : undefined],
        ["audio-button-configure|Open audio options|device-settings-button", params.deviceSettings],
        [
          "selected-microphone-display|microphone-select|audio-device-input|device-settings-microphone",
          selected,
        ],
        ["microphone-settings", menu],
        ["permission-prompt|permission-error", params.permissionPrompt],
      ];
      return matches.find(([needles]) =>
        needles.split("|").some((needle) => selector.includes(needle)),
      )?.[1];
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
  const window: Record<string, unknown> = {};
  let captionObserverCallback:
    | ((records?: Array<{ removedNodes: PageControl[] }>) => void)
    | undefined;
  let captionObserverDisconnects = 0;
  if (params.priorMeeting) {
    window[MEETING_STATE_KEY] = params.priorMeeting;
  }
  if (params.priorAudioOutputs) {
    window["__openclawTeamsAudioOutputs"] = params.priorAudioOutputs;
  }
  if (params.priorCaptions) {
    window["__openclawTeamsCaptions"] = params.priorCaptions;
  }
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
      mediaDevices: {
        enumerateDevices: async () => params.devices ?? [],
      },
      permissions: {
        query: async () => ({ state: params.microphonePermissionState ?? "prompt" }),
      },
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
    allowMicrophone: false,
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
    devices: [
      { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
      { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
    ],
    leave: control({ label: "Leave" }),
    microphone: control({ label: "Turn microphone off", pressed: true }),
    microphoneDevice: control({ label: "BlackHole 2ch" }),
    priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
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
  if (!params.omitMeetingState) {
    window[MEETING_STATE_KEY] = {
      sessionId: params.meetingSessionId ?? "session-1",
      ...params.priorMeeting,
    };
  }
  if (params.priorAudioOutputs) {
    window["__openclawTeamsAudioOutputs"] = params.priorAudioOutputs;
  }
  const run = runInNewContext(
    `(${teamsMeetingPageScripts.leave({ leaveInitiated: params.leaveInitiated ?? false, meetingSessionId: params.meetingSessionId ?? "session-1", meetingUrl: URL })})`,
    {
      URL: globalThis.URL,
      document,
      location,
      window,
    },
  ) as () => string;
  return { result: JSON.parse(run()) as Record<string, unknown>, window };
}
