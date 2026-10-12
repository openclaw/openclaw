import { expect, it } from "vitest";
import {
  channelHeader,
  fixture,
  inCall,
  page,
  PageNode,
  preview,
  qaNode,
} from "./slack-huddles-platform-adapter.test-helpers.js";

it("selects and verifies the virtual microphone before enabling in-call talk-back", async () => {
  const { document, mic } = inCall(undefined, true);
  const selected = new PageNode("div", { id: "microphone-info" }, "Built-in Microphone");
  const settings = qaNode("huddle-toolbar-mic-popover-button", "");
  const choice = qaNode("av-microphone-device-menu-item_BlackHole 2ch", "BlackHole 2ch");
  const micStates: Array<string | null> = [];
  settings.onClick = () => {
    micStates.push(mic.getAttribute("aria-checked"));
    document.body.append(choice);
  };
  choice.onClick = () => {
    selected.textContent = "BlackHole 2ch";
  };
  document.body.append(selected, settings);
  const result = await fixture({ document, joined: true }).status({ mode: "agent" });
  expect(micStates).toEqual(["false"]);
  expect(settings.clicks).toBe(1);
  expect(choice.clicks).toBe(1);
  expect(result).toMatchObject({ audioInputRouted: true, micMuted: false });
});

it.each(["agent", "transcribe"] as const)(
  "stops controls and hides metadata when membership vanishes during %s status",
  async (mode) => {
    const { document, mic } = inCall(undefined, true, false);
    const header = channelHeader(true);
    const settings = qaNode("huddle-toolbar-mic-popover-button", "");
    document.body.append(
      header,
      settings,
      new PageNode("div", { id: "microphone-info" }, "Built-in Microphone"),
      qaNode("huddle_window_titlebar_title", "Other team huddle"),
    );
    const toggleMicrophone = mic.onClick;
    mic.onClick = () => {
      toggleMicrophone?.();
      header.attributes.class = "p-huddle_channel_header_button__container";
    };
    const result = await fixture({ document, joined: true }).status({ mode });
    expect(mic.clicks).toBe(1);
    expect(settings.clicks).toBe(0);
    expect(result.inCall).toBe(false);
    expect(result.meetingTitle).toBeUndefined();
  },
);

it.each([
  { change: "call", reason: undefined },
  { change: "prompt", reason: "slack-confirmation-required" },
  { change: "camera", reason: "slack-camera-required" },
])(
  "refuses Join after $change changes while the preview microphone settles",
  async ({ change, reason }) => {
    const { document, join, mic } = preview("Join Huddle", true);
    const camera = new PageNode("button", {
      role: "switch",
      "aria-label": "Camera",
      "aria-checked": "false",
    });
    if (change === "camera") {
      document.body.append(camera);
    }
    const toggleMicrophone = mic.onClick;
    mic.onClick = () => {
      toggleMicrophone?.();
      if (change === "camera") {
        camera.setAttribute("aria-checked", "true");
      } else {
        document.body.append(
          change === "call"
            ? qaNode("huddle_toolbar__leave_button", "Leave Huddle")
            : qaNode("huddle_join_modal", "Switch huddles?", "div"),
        );
      }
    };
    const result = await fixture({ document }).status({ mode: "agent" });
    expect(mic.clicks).toBe(1);
    expect(join.clicks).toBe(0);
    expect(result.clickedJoin).not.toBe(true);
    if (reason) {
      expect(result).toMatchObject({ manualAction: { reason } });
    }
  },
);

it.each([
  { change: "human-mute", initial: true, inPreview: false },
  { change: "physical-input", initial: false, inPreview: false },
  { change: "physical-input", initial: true, inPreview: false },
  { change: "physical-input", initial: true, inPreview: true },
])(
  "rechecks the microphone after the camera await: $change / initial=$initial / preview=$inPreview",
  async ({ change, initial, inPreview }) => {
    const active = inPreview ? preview("Join Huddle", initial) : undefined;
    const { document, mic } = active ?? inCall(undefined, initial);
    const selected = new PageNode(
      "div",
      { id: "microphone-info" },
      change === "human-mute" ? "Built-in Microphone" : "BlackHole 2ch",
    );
    const camera = new PageNode("button", {
      role: "switch",
      "aria-label": "Camera",
      "aria-checked": "true",
    });
    camera.onClick = () => {
      camera.setAttribute("aria-checked", "false");
      if (change === "human-mute") {
        mic.setAttribute("aria-checked", "false");
      } else {
        selected.textContent = "Built-in Microphone";
      }
    };
    document.body.append(camera, selected);
    let microphoneAtJoin: string | null = null;
    if (active) {
      active.join.onClick = () => {
        microphoneAtJoin = mic.getAttribute("aria-checked");
      };
    }
    await fixture({ document, joined: !inPreview }).status({ mode: "agent" });
    expect(camera.clicks).toBe(1);
    expect(mic.getAttribute("aria-checked")).toBe("false");
    if (change === "human-mute" || !initial) {
      expect(mic.clicks).toBe(0);
    }
    if (active) {
      expect(active.join.clicks).toBe(1);
      expect(microphoneAtJoin).toBe("false");
    }
  },
);

it("re-mutes when Slack leaves the virtual input right after the microphone unmutes", async () => {
  const { document, mic } = inCall(undefined, false);
  const selected = new PageNode("div", { id: "microphone-info" }, "BlackHole 2ch");
  const toggleMicrophone = mic.onClick;
  mic.onClick = () => {
    toggleMicrophone?.();
    if (mic.getAttribute("aria-checked") === "true") {
      selected.textContent = "Built-in Microphone";
    }
  };
  document.body.append(selected);
  await fixture({ document, joined: true }).status({ mode: "agent" });
  expect(mic.clicks).toBe(2);
  expect(mic.getAttribute("aria-checked")).toBe("false");
});

it("does not mute or route playback when membership ends during device enumeration", async () => {
  const { document } = inCall(undefined, true, false);
  const header = channelHeader(true);
  let muteWrites = 0;
  const playback = Object.assign(new PageNode("audio"), {
    sinkId: "physical-out",
    async setSinkId(sinkId: string) {
      this.sinkId = sinkId;
    },
  });
  Object.defineProperty(playback, "muted", {
    get: () => false,
    set: () => {
      muteWrites += 1;
    },
  });
  document.body.append(
    header,
    playback,
    qaNode("huddle_window_titlebar_title", "Other team huddle"),
    new PageNode("div", { id: "microphone-info" }, "BlackHole 2ch"),
  );
  const result = await fixture({
    document,
    joined: true,
    devices: [{ kind: "audiooutput", label: "BlackHole 2ch", deviceId: "virtual-out" }],
    onEnumerateDevices: () => {
      header.attributes.class = "p-huddle_channel_header_button__container";
    },
  }).status({ mode: "agent" });
  expect(playback.sinkId).toBe("physical-out");
  expect(muteWrites).toBe(0);
  expect(result).toMatchObject({ inCall: false, audioOutputRouted: false });
  expect(result.meetingTitle).toBeUndefined();
});

it("does not mistake an available virtual microphone for Slack's selected input", async () => {
  const { document } = inCall(undefined, true);
  document.body.append(
    new PageNode("div", { id: "microphone-info" }, "Built-in Microphone"),
    qaNode("av-microphone-device-menu-item_BlackHole 2ch", "BlackHole 2ch"),
  );
  const result = await fixture({ document, joined: true }).status({
    mode: "agent",
    readOnly: true,
  });
  expect(result).toMatchObject({
    audioInputRouted: false,
    manualAction: { reason: "slack-audio-choice-required" },
  });
});

it.each(["Mute microphone", "Unmute microphone"])(
  "reads the alternate %s control",
  async (label) => {
    const mic = new PageNode("button", {
      "data-qa": "segmented-mute-button-main",
      "aria-label": label,
    });
    const document = page(qaNode("huddle_toolbar__leave_button"), mic, channelHeader(true));
    expect(await fixture({ document, joined: true }).status({ readOnly: true })).toMatchObject({
      inCall: true,
      micMuted: label === "Unmute microphone",
    });
  },
);

it.each([false, true])(
  "rechecks the input after shared routing (readOnly=%s)",
  async (readOnly) => {
    const { document, mic } = inCall(undefined, true);
    const selected = new PageNode("div", { id: "microphone-info" }, "BlackHole 2ch");
    const playback = Object.assign(new PageNode("audio"), { setSinkId: async () => {} });
    document.body.append(selected, playback);
    const result = await fixture({
      document,
      joined: true,
      onEnumerateDevices: () => {
        selected.textContent = "Built-in Microphone";
      },
    }).status({ mode: "agent", readOnly });
    if (readOnly) {
      expect(mic.clicks).toBe(0);
    } else {
      expect(mic.getAttribute("aria-checked")).toBe("false");
    }
    expect(result.audioInputRouted).toBe(false);
  },
);

it("stops clicking once another session takes over the page during an awaited step", async () => {
  const { document, mic } = inCall(undefined, true);
  const browser = fixture({ document, joined: true });
  const camera = new PageNode("button", {
    role: "switch",
    "aria-label": "Camera",
    "aria-checked": "true",
  });
  camera.onClick = () => {
    camera.setAttribute("aria-checked", "false");
    Object.assign(browser.window, {
      __openclawSlackHuddle: {
        identity: "slack-huddle:T0123ABCD:C0123ABCD",
        sessionId: "session-2",
      },
    });
  };
  document.body.append(camera);
  await browser.status({ mode: "transcribe" });
  expect(camera.clicks).toBe(1);
  expect(mic.clicks).toBe(0);
});
