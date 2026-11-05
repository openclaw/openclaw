import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { assert, expect, it, vi } from "vitest";
import { meetStatusScript } from "./google-meet-page-scripts.js";
import { GOOGLE_MEET_PLATFORM_ADAPTER } from "./google-meet-platform-adapter.js";

const label = "BlackHole 2ch (Virtual)";
const outputLabel = (name: string) => (name.includes("OpenClaw") ? "OpenClaw Meeting Audio" : name);
const ready = (health: Parameters<typeof MeetingPlatformAdapter.isRealtimeRouteReady>[1]) =>
  MeetingPlatformAdapter.isRealtimeRouteReady("agent", health);
const microphoneMenu = `<button aria-haspopup="menu" aria-label="Microphone: ${label}"></button>`;
const speakerMenu = `<button aria-haspopup="menu" aria-label="Speaker: ${label}"></button>`;
const nativeMicrophone = `<select aria-label="Microphone"><option selected>${label}</option></select>`;

async function inspectAudioPage(
  controls: string,
  options: {
    readOnly?: boolean;
    outputAvailable?: boolean;
    deviceLabel?: string;
    muted?: boolean;
    setup?: (document: Document) => void;
  } = {},
) {
  const deviceLabel = options.deviceLabel ?? label;
  const devices = [
    { deviceId: "input-1", kind: "audioinput", label: deviceLabel },
    { deviceId: "output-1", kind: "audiooutput", label: outputLabel(deviceLabel) },
  ];
  const dom = new JSDOM(
    `<button id="microphone" aria-label="Turn ${options.muted === false ? "off" : "on"} microphone"></button>
     <button aria-label="Leave call"></button>${controls}`,
    { url: "https://meet.google.com/abc-defg-hij" },
  );
  const { document } = dom.window;
  const microphone = document.getElementById("microphone")!;
  const click = vi.fn(() => {
    const muted = microphone.getAttribute("aria-label") === "Turn on microphone";
    microphone.setAttribute("aria-label", `Turn ${muted ? "off" : "on"} microphone`);
  });
  microphone.addEventListener("click", click);
  options.setup?.(document);
  try {
    const result = await runInNewContext(
      `(${meetStatusScript({
        allowMicrophone: true,
        autoJoin: false,
        captionSessionId: "session-1",
        captureCaptions: false,
        guestName: "OpenClaw Agent",
        readOnly: options.readOnly,
      })})()`,
      {
        document,
        window: dom.window,
        location: dom.window.location,
        Event: dom.window.Event,
        navigator: {
          mediaDevices: {
            enumerateDevices: async () =>
              options.outputAvailable === false ? devices.slice(0, 1) : devices,
          },
        },
        setTimeout: (callback: () => void) => {
          callback();
          return 1;
        },
      },
    );
    return { health: JSON.parse(result) as Record<string, unknown>, click };
  } finally {
    dom.window.close();
  }
}

it.each([
  [microphoneMenu, false, true],
  [`<div role="button" aria-haspopup="menu" aria-label="mIcRoPhOnE: ${label}"></div>`, false, true],
  [microphoneMenu, true, true],
  [
    '<button aria-haspopup="menu" aria-label="Microphone: Built-in Microphone"></button>',
    true,
    false,
  ],
] as const)("inspects microphone %s (readOnly=%s)", async (control, readOnly, routed) => {
  const deviceClick = vi.fn();
  const { health, click } = await inspectAudioPage(control + speakerMenu, {
    readOnly,
    setup(document) {
      document.querySelector('[aria-haspopup="menu"]')!.addEventListener("click", deviceClick);
    },
  });
  expect(health).toMatchObject({
    audioInputRouted: routed,
    audioOutputRouted: true,
    micMuted: readOnly,
  });
  expect(deviceClick).not.toHaveBeenCalled();
  expect(click).toHaveBeenCalledTimes(readOnly ? 0 : 1);
});

it.each([true, false])(
  "confirms microphone menu switching before unmuting (%s)",
  async (switches) => {
    const { health } = await inspectAudioPage(
      `<button id="device" aria-haspopup="menu" aria-label="Microphone: Built-in Microphone"></button>
     <div role="menuitemradio" aria-checked="false">${label}</div>${speakerMenu}`,
      {
        setup(document) {
          document.querySelector('[role="menuitemradio"]')!.addEventListener("click", () => {
            if (switches) {
              document.getElementById("device")!.setAttribute("aria-label", `Microphone: ${label}`);
            }
          });
        },
      },
    );
    expect(health).toMatchObject({ audioInputRouted: switches, micMuted: !switches });
    if (!switches) {
      expect(health.manualAction).toMatchObject({ reason: "meet-audio-choice-required" });
    }
  },
);

it.each([
  ["BlackHole 2ch", true],
  ["Monitor of OpenClaw Meeting Audio", true],
  ["OpenClaw Meeting Audio", false],
] as const)("routes %s only after input verification (%s)", async (deviceLabel, verified) => {
  const { health } = await inspectAudioPage(
    `<select aria-label="Microphone"><option>MacBook Microphone</option>${verified ? `<option>${deviceLabel}</option>` : ""}</select>`,
    {
      deviceLabel,
      muted: verified,
      setup(document) {
        const media = document.createElement("audio");
        media.setSinkId = async (value) => {
          Object.defineProperty(media, "sinkId", { value, configurable: true });
        };
        document.body.append(media);
      },
    },
  );
  expect(health).toMatchObject({
    inCall: true,
    audioInputRouted: verified,
    audioOutputRouted: true,
    micMuted: !verified,
    ...(verified
      ? { audioInputDeviceLabel: deviceLabel, audioOutputDeviceLabel: outputLabel(deviceLabel) }
      : {
          audioInputRouteError: "Meet did not confirm OpenClaw Meeting Audio as its microphone.",
          manualAction: { reason: "meet-audio-choice-required" },
        }),
  });
  if (verified) {
    expect(health.manualAction).toBeUndefined();
  } else {
    expect(ready(health)).toBe(false);
  }
});

it.each([true, false])("requires current Meet capture ownership (%s)", async (owns) => {
  const url = "https://meet.google.com/abc-defg-hij";
  const source = GOOGLE_MEET_PLATFORM_ADAPTER.browser.buildAudioCaptureScript?.({
    action: "start",
    captureId: "capture-1",
    meetingSessionId: "session-1",
    meetingUrl: url,
  });
  const result = runInNewContext(`(${source})()`, {
    URL,
    location: { href: url },
    window: {
      __openclawMeetAudioSession: owns ? "session-1" : "session-2",
      __openclawMeetPlayback: { early: true },
    },
    document: {
      querySelectorAll: () => [
        { getAttribute: (name: string) => (name === "aria-label" ? "Leave call" : null) },
      ],
    },
    AudioContext: function AudioContext() {
      throw new Error("capture admitted");
    },
  });
  await expect(result).rejects.toThrow(owns ? "capture admitted" : "no longer owns");
});

it("parses input-route health and retries until both routes are ready", () => {
  const status = {
    inCall: true,
    micMuted: false,
    audioInputRouted: true,
    audioInputDeviceLabel: "OpenClaw Meeting Audio",
    audioOutputRouted: false,
    manualAction: { reason: "meet-audio-choice-required", message: "Select the virtual speaker" },
  };
  const adapter = GOOGLE_MEET_PLATFORM_ADAPTER.browser;
  const pending = adapter.parseStatus({ result: JSON.stringify(status) });
  expect(pending).toMatchObject(status);
  assert(pending, "expected parsed Google Meet browser health");
  expect(adapter.shouldRetryJoinStatus?.(pending)).toBe(true);
  expect(ready({ ...pending, audioOutputRouted: true, manualAction: undefined })).toBe(true);
  expect(ready(pending)).toBe(false);
});

it.each([
  `<button aria-haspopup="menu" aria-label="Microphone settings: ${label}"></button>`,
  speakerMenu,
])("does not treat other device controls as a selected microphone: %s", async (control) => {
  const { health, click } = await inspectAudioPage(control);
  expect(health).toMatchObject({
    audioInputRouted: false,
    micMuted: true,
    manualAction: { reason: "meet-audio-choice-required" },
  });
  expect(click).not.toHaveBeenCalled();
});

it.each([
  [speakerMenu, true, true],
  [`<div role="button" aria-haspopup="menu" aria-label="sPeAkEr: ${label}"></div>`, true, true],
  ['<button aria-haspopup="menu" aria-label="Speaker: Built-in Speakers"></button>', true, false],
  ["", true, false],
  [speakerMenu, false, false],
] as const)(
  "verifies speaker selection without DOM media (%s, available=%s)",
  async (speaker, available, routed) => {
    const { health } = await inspectAudioPage(nativeMicrophone + speaker, {
      outputAvailable: available,
    });
    expect(health.audioOutputRouted).toBe(routed);
    if (routed) {
      expect(health.audioOutputDeviceLabel).toBe(label);
      expect(health.manualAction).toBeUndefined();
    } else {
      expect(health.manualAction).toMatchObject({ reason: "meet-audio-choice-required" });
    }
  },
);

it.each([false, true])(
  "keeps routing Meet media after one element rejects setSinkId (audio rejects=%s)",
  async (audioRejects) => {
    const rejection = "AbortError: The operation could not be performed";
    const { health } = await inspectAudioPage(nativeMicrophone, {
      setup(document) {
        for (const [tag, rejects] of [
          ["video", true],
          ["audio", audioRejects],
        ] as const) {
          const media = document.createElement(tag);
          media.setSinkId = async (value) => {
            if (rejects) {
              throw new Error(rejection);
            }
            Object.defineProperty(media, "sinkId", { value, configurable: true });
          };
          document.body.append(media);
        }
      },
    });
    expect(health).toMatchObject({
      audioOutputRouted: !audioRejects,
      audioOutputRouteError: rejection,
    });
    expect(health.notes).toContain(
      audioRejects
        ? `Could not route Meet speaker output to the virtual audio device: ${rejection}`
        : `1 Meet media element(s) rejected the speaker route: ${rejection}`,
    );
    expect(ready(health)).toBe(!audioRejects);
  },
);
