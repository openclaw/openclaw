import { runInNewContext } from "node:vm";
import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { assert, expect, it, vi } from "vitest";
import { meetStatusScript } from "./google-meet-page-scripts.js";
import { GOOGLE_MEET_PLATFORM_ADAPTER } from "./google-meet-platform-adapter.js";

const MEETING_URL = "https://meet.google.com/abc-defg-hij";
const audioLabel = "OpenClaw Meeting Audio";
const routeReason = "meet-audio-choice-required";
const outputLabel = (label: string) => (label.includes("OpenClaw") ? audioLabel : label);
const adapter = GOOGLE_MEET_PLATFORM_ADAPTER.browser;
const ready = (health: Parameters<typeof MeetingPlatformAdapter.isRealtimeRouteReady>[1]) =>
  MeetingPlatformAdapter.isRealtimeRouteReady("agent", health);

it.each([true, false])("requires current Meet capture ownership (%s)", async (owns) => {
  const source = adapter.buildAudioCaptureScript?.({
    action: "start",
    captureId: "capture-1",
    meetingSessionId: "session-1",
    meetingUrl: MEETING_URL,
  });
  const result = runInNewContext(`(${source})()`, {
    URL,
    location: { href: MEETING_URL },
    window: { __openclawMeetAudioSession: owns ? "session-1" : "session-2" },
    document: { querySelectorAll: () => [pageNode("Leave call")] },
    AudioContext: function AudioContext() {
      throw new Error("capture admitted");
    },
  });
  await expect(result).rejects.toThrow(owns ? "capture admitted" : "no longer owns");
});

function pageNode(label: string) {
  return {
    getAttribute: (name: string) => (name === "aria-label" ? label : null),
  };
}

function microphoneSelect(labels: string[]) {
  const options = labels.map((label, index) => ({ label, value: `device-${index}` }));
  return {
    dispatchEvent: vi.fn(),
    options,
    value: options[0]?.value,
    get selectedOptions() {
      return options.filter((option) => option.value === this.value);
    },
  };
}

async function runAudioStatus(label: string, inputAvailable = true) {
  let muted = inputAvailable;
  const microphone = {
    click: vi.fn(() => {
      muted = !muted;
    }),
    getAttribute: (name: string) =>
      name === "aria-label" ? `Turn ${muted ? "on" : "off"} microphone` : null,
  };
  const select = microphoneSelect(
    inputAvailable ? ["MacBook Microphone", label] : ["MacBook Microphone"],
  );
  const media = {
    sinkId: "",
    setSinkId: vi.fn(async (value: string) => {
      media.sinkId = value;
    }),
  };
  const buttons = [microphone, pageNode("Leave call")];
  const document = {
    querySelector(selector: string) {
      return selector.includes("select") && selector.includes("microphone") ? select : null;
    },
    querySelectorAll(selector: string) {
      return selector === "audio, video"
        ? [media]
        : selector.includes("button") || selector.includes('[role="')
          ? buttons
          : [];
    },
  };
  const result = await runInNewContext(
    `(${meetStatusScript({
      allowMicrophone: true,
      autoJoin: false,
      captureCaptions: false,
      guestName: "OpenClaw Agent",
    })})()`,
    {
      Event: globalThis.Event,
      document,
      location: { href: MEETING_URL, hostname: "meet.google.com" },
      navigator: {
        mediaDevices: {
          enumerateDevices: async () => [
            { deviceId: "input-1", kind: "audioinput", label },
            { deviceId: "output-1", kind: "audiooutput", label: outputLabel(label) },
          ],
        },
      },
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      },
      window: {},
    },
  );
  return { health: JSON.parse(result) as Record<string, unknown>, media, microphone, select };
}

it.each([
  ["BlackHole 2ch", true],
  ["Monitor of OpenClaw Meeting Audio", true],
  [audioLabel, false],
] as const)("routes %s only after input verification (%s)", async (label, verified) => {
  const { health, media, microphone, select } = await runAudioStatus(label, verified);
  expect(health).toMatchObject({
    audioInputRouted: verified,
    audioOutputRouted: true,
    micMuted: !verified,
    ...(verified
      ? {
          audioInputDeviceLabel: label,
          audioOutputDeviceLabel: outputLabel(label),
        }
      : {
          audioInputRouteError: "Meet did not confirm OpenClaw Meeting Audio as its microphone.",
          manualAction: { reason: routeReason },
        }),
  });
  expect(microphone.click).toHaveBeenCalledOnce();
  if (verified) {
    expect(health.manualAction).toBeUndefined();
    expect(select.dispatchEvent).toHaveBeenCalledTimes(2);
    expect(media.setSinkId).toHaveBeenCalledWith("output-1");
  } else {
    expect(ready(health)).toBe(false);
  }
});

it("parses input-route health and retries until both routes are ready", () => {
  const status = {
    inCall: true,
    micMuted: false,
    audioInputRouted: true,
    audioInputDeviceLabel: audioLabel,
    audioOutputRouted: false,
    manualAction: { reason: routeReason, message: "Select the virtual speaker" },
  };
  const pending = adapter.parseStatus({ result: JSON.stringify(status) });
  expect(pending).toMatchObject(status);
  assert(pending, "expected parsed Google Meet browser health");
  expect(adapter.shouldRetryJoinStatus?.(pending)).toBe(true);
  expect(ready({ ...pending, audioOutputRouted: true, manualAction: undefined })).toBe(true);
  expect(ready(pending)).toBe(false);
});
