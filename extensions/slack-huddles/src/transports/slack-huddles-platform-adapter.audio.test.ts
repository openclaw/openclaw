import { expect, it } from "vitest";
import {
  channelHeader,
  CLIENT_URL,
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

it("stops routing clicks when Slack's membership header vanishes during an awaited step", async () => {
  const { document, mic } = inCall(undefined, true);
  const header = document.body.children.find((node) =>
    (node.attributes.class ?? "").includes("p-huddle_channel_header_button--in_huddle"),
  );
  const settings = qaNode("huddle-toolbar-mic-popover-button", "");
  document.body.append(
    new PageNode("div", { id: "microphone-info" }, "Built-in Microphone"),
    settings,
  );
  const toggleMicrophone = mic.onClick;
  mic.onClick = () => {
    toggleMicrophone?.();
    if (header) {
      header.attributes.class = "p-huddle_channel_header_button__container";
    }
  };
  await fixture({ document, joined: true }).status({ mode: "agent" });
  expect(mic.clicks).toBe(1);
  expect(settings.clicks).toBe(0);
});

it("does not click Join when another call appears while the preview microphone settles", async () => {
  const { document, join, mic } = preview("Join Huddle", true);
  const toggleMicrophone = mic.onClick;
  mic.onClick = () => {
    toggleMicrophone?.();
    document.body.append(qaNode("huddle_toolbar__leave_button", "Leave Huddle"));
  };
  const result = await fixture({ document }).status({ mode: "agent" });
  expect(mic.clicks).toBe(1);
  expect(join.clicks).toBe(0);
  expect(result.clickedJoin).not.toBe(true);
});

it("stops before Join and reports a switch prompt that appears while the preview settles", async () => {
  const { document, join, mic } = preview("Join Huddle", true);
  const toggleMicrophone = mic.onClick;
  mic.onClick = () => {
    toggleMicrophone?.();
    document.body.append(qaNode("huddle_join_modal", "Switch huddles?", "div"));
  };
  const result = await fixture({ document }).status({ mode: "agent" });
  expect(join.clicks).toBe(0);
  expect(result).toMatchObject({ manualAction: { reason: "slack-confirmation-required" } });
});

it("omits another huddle's title and participants while membership is unverified", async () => {
  const { document } = inCall(undefined, false, false);
  document.body.append(
    qaNode("huddle_window_titlebar_title", "Other team huddle"),
    qaNode("huddle_avatar_stack__member", ""),
  );
  const result = await fixture({
    document,
    currentUrl: CLIENT_URL,
    window: {
      __openclawSlackHuddle: {
        identity: "slack-huddle:T0123ABCD:C0123ABCD",
        sessionId: "session-1",
        joinRequested: true,
        joinRequestedAt: Date.now(),
      },
    },
  }).status({ readOnly: true });
  expect(result.inCall).toBe(false);
  expect(result.meetingTitle).toBeUndefined();
  expect(result.participantCount).toBeUndefined();
});

it("reports the call as unverified when membership is lost during status work", async () => {
  const { document, mic } = inCall(undefined, true);
  const header = document.body.children.find((node) =>
    (node.attributes.class ?? "").includes("p-huddle_channel_header_button--in_huddle"),
  );
  document.body.append(qaNode("huddle_window_titlebar_title", "Other team huddle"));
  const toggleMicrophone = mic.onClick;
  mic.onClick = () => {
    toggleMicrophone?.();
    if (header) {
      header.attributes.class = "p-huddle_channel_header_button__container";
    }
  };
  const result = await fixture({ document, joined: true }).status({ mode: "transcribe" });
  expect(mic.clicks).toBe(1);
  expect(result.inCall).toBe(false);
  expect(result.meetingTitle).toBeUndefined();
});

it("never re-enables a microphone someone muted while the status script awaited", async () => {
  const { document, mic } = inCall(undefined, true);
  const camera = new PageNode("button", {
    role: "switch",
    "aria-label": "Camera",
    "aria-checked": "true",
  });
  camera.onClick = () => {
    camera.setAttribute("aria-checked", "false");
    mic.setAttribute("aria-checked", "false");
  };
  document.body.append(camera);
  await fixture({ document, joined: true }).status({ mode: "agent" });
  expect(camera.clicks).toBe(1);
  expect(mic.clicks).toBe(0);
  expect(mic.getAttribute("aria-checked")).toBe("false");
});

it("never unmutes when Slack switches away from the virtual input during an await", async () => {
  const { document, mic } = inCall(undefined, false);
  const selected = new PageNode("div", { id: "microphone-info" }, "BlackHole 2ch");
  const camera = new PageNode("button", {
    role: "switch",
    "aria-label": "Camera",
    "aria-checked": "true",
  });
  camera.onClick = () => {
    camera.setAttribute("aria-checked", "false");
    selected.textContent = "Built-in Microphone";
  };
  document.body.append(selected, camera);
  await fixture({ document, joined: true }).status({ mode: "agent" });
  expect(camera.clicks).toBe(1);
  expect(mic.clicks).toBe(0);
  expect(mic.getAttribute("aria-checked")).toBe("false");
});

it("mutes before joining once Slack's selected input is no longer virtual", async () => {
  const { document, join, mic } = preview("Join Huddle", true);
  const selected = new PageNode("div", { id: "microphone-info" }, "BlackHole 2ch");
  const camera = new PageNode("button", {
    role: "switch",
    "aria-label": "Camera",
    "aria-checked": "true",
  });
  camera.onClick = () => {
    camera.setAttribute("aria-checked", "false");
    selected.textContent = "Built-in Microphone";
  };
  document.body.append(selected, camera);
  let microphoneAtJoin: string | null = null;
  join.onClick = () => {
    microphoneAtJoin = mic.getAttribute("aria-checked");
  };
  await fixture({ document }).status({ mode: "agent" });
  expect(join.clicks).toBe(1);
  expect(microphoneAtJoin).toBe("false");
});

it("does not join with video when the camera turns on while the microphone settles", async () => {
  const { document, join, mic } = preview("Join Huddle", true);
  const camera = new PageNode("button", {
    role: "switch",
    "aria-label": "Camera",
    "aria-checked": "false",
  });
  const toggleMicrophone = mic.onClick;
  mic.onClick = () => {
    toggleMicrophone?.();
    camera.setAttribute("aria-checked", "true");
  };
  document.body.append(camera);
  const result = await fixture({ document }).status({ mode: "agent" });
  expect(mic.clicks).toBe(1);
  expect(join.clicks).toBe(0);
  expect(result).toMatchObject({ manualAction: { reason: "slack-camera-required" } });
});

it("mutes a live microphone when Slack switches away from the virtual input during an await", async () => {
  const { document, mic } = inCall(undefined, true);
  const selected = new PageNode("div", { id: "microphone-info" }, "BlackHole 2ch");
  const camera = new PageNode("button", {
    role: "switch",
    "aria-label": "Camera",
    "aria-checked": "true",
  });
  camera.onClick = () => {
    camera.setAttribute("aria-checked", "false");
    selected.textContent = "Built-in Microphone";
  };
  document.body.append(selected, camera);
  await fixture({ document, joined: true }).status({ mode: "agent" });
  expect(mic.getAttribute("aria-checked")).toBe("false");
});

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

it("re-mutes when Slack leaves the virtual input during the shared routing await", async () => {
  const { document, mic } = inCall(undefined, true);
  const selected = new PageNode("div", { id: "microphone-info" }, "BlackHole 2ch");
  const playback = Object.assign(new PageNode("audio"), { setSinkId: async () => {} });
  document.body.append(selected, playback);
  await fixture({
    document,
    joined: true,
    onEnumerateDevices: () => {
      selected.textContent = "Built-in Microphone";
    },
  }).status({ mode: "agent" });
  expect(mic.getAttribute("aria-checked")).toBe("false");
});

it("reports but does not click during a read-only pass when the virtual input disappears", async () => {
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
  }).status({ mode: "agent", readOnly: true });
  expect(mic.clicks).toBe(0);
  expect(result.audioInputRouted).toBe(false);
});

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
