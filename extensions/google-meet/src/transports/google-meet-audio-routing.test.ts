import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";
import { meetStatusScript } from "./google-meet-page-scripts.js";

const label = "BlackHole 2ch (Virtual)";
const microphoneMenu = `<button aria-haspopup="menu" aria-label="Microphone: ${label}"></button>`;
const speakerMenu = `<button aria-haspopup="menu" aria-label="Speaker: ${label}"></button>`;
const nativeMicrophone = `<select aria-label="Microphone"><option selected>${label}</option></select>`;
const devices = [
  { deviceId: "input-1", kind: "audioinput", label },
  { deviceId: "output-1", kind: "audiooutput", label },
];

async function inspectAudioPage(
  controls: string,
  options: {
    readOnly?: boolean;
    outputAvailable?: boolean;
    setup?: (document: Document) => void;
  } = {},
) {
  const dom = new JSDOM(
    `<button id="microphone" aria-label="Turn on microphone"></button>
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
  microphoneMenu,
  `<div role="button" aria-haspopup="menu" aria-label="mIcRoPhOnE: ${label}"></div>`,
])("recognizes a selected virtual microphone menu: %s", async (control) => {
  const { health, click } = await inspectAudioPage(control + speakerMenu);
  expect(health).toMatchObject({ audioInputRouted: true, micMuted: false });
  expect(click).toHaveBeenCalledOnce();
});

it.each([true, false])(
  "confirms microphone menu switching before unmuting (%s)",
  async (switches) => {
    const { health, click } = await inspectAudioPage(
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
    expect(click).toHaveBeenCalledTimes(switches ? 1 : 0);
    if (!switches) {
      expect(health.manualAction).toMatchObject({ reason: "meet-audio-choice-required" });
    }
  },
);

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

it.each([label, "Built-in Microphone"])(
  "inspects microphone menus without changing them (%s)",
  async (selected) => {
    const deviceClick = vi.fn();
    const { health, click } = await inspectAudioPage(
      `<button aria-haspopup="menu" aria-label="Microphone: ${selected}"></button>${speakerMenu}`,
      {
        readOnly: true,
        setup(document) {
          document.querySelector('[aria-haspopup="menu"]')!.addEventListener("click", deviceClick);
        },
      },
    );
    expect(health).toMatchObject({
      audioInputRouted: selected === label,
      audioOutputRouted: true,
      micMuted: true,
    });
    expect(click).not.toHaveBeenCalled();
    expect(deviceClick).not.toHaveBeenCalled();
  },
);
