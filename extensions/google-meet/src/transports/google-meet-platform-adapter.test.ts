import { runInNewContext } from "node:vm";
import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { describe, expect, it, vi } from "vitest";
import { meetStatusScript, meetTranscriptScript } from "./google-meet-page-scripts.js";
import { GOOGLE_MEET_PLATFORM_ADAPTER } from "./google-meet-platform-adapter.js";

const MEETING_URL = "https://meet.google.com/abc-defg-hij";

it.each([true, false])(
  "starts browser capture only for the current Meet session (owner=%s)",
  async (owns) => {
    const source = GOOGLE_MEET_PLATFORM_ADAPTER.browser.buildAudioCaptureScript?.({
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
  },
);

function pageNode(label: string) {
  return {
    disabled: false,
    textContent: label,
    click: vi.fn(),
    getAttribute: (name: string) => (name === "aria-label" ? label : null),
  };
}

function microphoneSelect(labels: string[]) {
  const options = labels.map((label, index) => ({
    label,
    selected: index === 0,
    textContent: label,
    value: `device-${index}`,
  }));
  let value = options[0]?.value;
  return {
    dispatchEvent: vi.fn(),
    get options() {
      return options;
    },
    get selectedOptions() {
      return options.filter((option) => option.selected);
    },
    getAttribute: (name: string) => (name === "aria-label" ? "Microphone" : null),
    textContent: "",
    get value() {
      return value;
    },
    set value(next: string | undefined) {
      value = next;
      for (const option of options) {
        option.selected = option.value === next;
      }
    },
  };
}

async function runAudioStatus(
  label: string,
  selectLabels = ["MacBook Microphone", label],
  initialMicrophoneLabel = "Turn on microphone",
) {
  let microphoneLabel = initialMicrophoneLabel;
  const microphone = pageNode("");
  microphone.getAttribute = (name: string) => (name === "aria-label" ? microphoneLabel : null);
  microphone.click.mockImplementation(() => {
    microphoneLabel = /turn on microphone/i.test(microphoneLabel)
      ? "Turn off microphone"
      : "Turn on microphone";
  });
  const leave = pageNode("Leave call");
  const select = microphoneSelect(selectLabels);
  const media = {
    sinkId: "",
    setSinkId: vi.fn(async (value: string) => {
      media.sinkId = value;
    }),
  };
  const buttons = [microphone, leave];
  const document = {
    body: { textContent: "" },
    title: "Meet",
    querySelector(selector: string) {
      if (selector.includes("select") && selector.includes("microphone")) {
        return select;
      }
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === "button") {
        return buttons;
      }
      if (selector === "input") {
        return [];
      }
      if (selector === "audio, video") {
        return [media];
      }
      if (selector.includes("button") || selector.includes('[role="')) {
        return buttons;
      }
      return [];
    },
  };
  const outputLabel = label.includes("OpenClaw") ? "OpenClaw Meeting Audio" : label;
  const result = await runInNewContext(
    `(${meetStatusScript({
      allowMicrophone: true,
      autoJoin: false,
      captureCaptions: false,
      guestName: "OpenClaw Agent",
    })})()`,
    {
      Event: globalThis.Event,
      JSON,
      String,
      document,
      location: { href: MEETING_URL, hostname: "meet.google.com" },
      navigator: {
        mediaDevices: {
          enumerateDevices: async () => [
            { deviceId: "input-1", kind: "audioinput", label },
            { deviceId: "output-1", kind: "audiooutput", label: outputLabel },
          ],
        },
      },
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      },
      clearTimeout,
      window: {},
    },
  );
  return {
    health: JSON.parse(result) as Record<string, unknown>,
    media,
    microphone,
    select,
  };
}

describe("GOOGLE_MEET_PLATFORM_ADAPTER captions", () => {
  it("enables caption capture for durable notes in every browser mode", () => {
    expect(GOOGLE_MEET_PLATFORM_ADAPTER.browser.captions.enabled("agent")).toBe(true);
    expect(GOOGLE_MEET_PLATFORM_ADAPTER.browser.captions.enabled("bidi")).toBe(true);
    expect(GOOGLE_MEET_PLATFORM_ADAPTER.browser.captions.enabled("transcribe")).toBe(true);
  });
});

describe("GOOGLE_MEET_PLATFORM_ADAPTER audio routing", () => {
  it.each(["BlackHole 2ch", "Monitor of OpenClaw Meeting Audio"])(
    "selects and verifies %s for bidirectional Meet audio",
    async (label) => {
      const { health, media, microphone, select } = await runAudioStatus(label);

      expect(health).toMatchObject({
        audioInputRouted: true,
        audioInputDeviceLabel: label,
        audioOutputRouted: true,
        audioOutputDeviceLabel: label.includes("OpenClaw") ? "OpenClaw Meeting Audio" : label,
        micMuted: false,
      });
      expect(health.manualAction).toBeUndefined();
      expect(select.dispatchEvent).toHaveBeenCalledTimes(2);
      expect(microphone.click).toHaveBeenCalledOnce();
      expect(media.setSinkId).toHaveBeenCalledWith("output-1");
    },
  );

  it("parses input-route health and retries until both routes are ready", () => {
    const pending = GOOGLE_MEET_PLATFORM_ADAPTER.browser.parseStatus({
      result: JSON.stringify({
        inCall: true,
        micMuted: false,
        audioInputRouted: true,
        audioInputDeviceLabel: "OpenClaw Meeting Audio",
        audioOutputRouted: false,
        manualAction: {
          reason: "meet-audio-choice-required",
          message: "Select the virtual speaker",
        },
      }),
    });

    expect(pending).toMatchObject({
      audioInputRouted: true,
      audioInputDeviceLabel: "OpenClaw Meeting Audio",
      audioOutputRouted: false,
    });
    if (!pending) {
      throw new Error("expected parsed Google Meet browser health");
    }
    expect(GOOGLE_MEET_PLATFORM_ADAPTER.browser.shouldRetryJoinStatus?.(pending)).toBe(true);
    expect(
      MeetingPlatformAdapter.isRealtimeRouteReady("agent", {
        ...pending,
        audioOutputRouted: true,
        manualAction: undefined,
      }),
    ).toBe(true);
    expect(MeetingPlatformAdapter.isRealtimeRouteReady("agent", pending)).toBe(false);
  });

  it("keeps Meet muted and reports manual action when input selection cannot be verified", async () => {
    const { health, microphone } = await runAudioStatus(
      "OpenClaw Meeting Audio",
      ["MacBook Microphone"],
      "Turn off microphone",
    );

    expect(health).toMatchObject({
      audioInputRouted: false,
      audioInputRouteError: "Meet did not confirm OpenClaw Meeting Audio as its microphone.",
      audioOutputRouted: true,
      micMuted: true,
      manualAction: { reason: "meet-audio-choice-required" },
    });
    expect(microphone.click).toHaveBeenCalledOnce();
    expect(MeetingPlatformAdapter.isRealtimeRouteReady("agent", health)).toBe(false);
  });
});

class MockTextNode {
  readonly nodeType = 3;
  text: string;
  parent: MockCaptionElement | null = null;

  constructor(text: string) {
    this.text = text;
  }

  get textContent(): string {
    return this.text;
  }

  set textContent(value: string) {
    this.text = value;
  }

  get childNodes(): never[] {
    return [];
  }

  get children(): never[] {
    return [];
  }

  matches(): boolean {
    return false;
  }

  querySelector(): null {
    return null;
  }

  querySelectorAll(): never[] {
    return [];
  }

  cloneNode(): MockTextNode {
    return new MockTextNode(this.text);
  }

  remove() {
    if (this.parent) {
      const nodes = this.parent.childNodes as Array<MockCaptionElement | MockTextNode>;
      const idx = nodes.indexOf(this);
      if (idx >= 0) {
        nodes.splice(idx, 1);
      }
      this.parent = null;
    }
  }
}

type CaptionChild = MockCaptionElement | MockTextNode;

class MockCaptionElement {
  readonly nodeType = 1;
  tagName: string;
  attributes: Record<string, string>;
  children: MockCaptionElement[] = [];
  childNodes: CaptionChild[] = [];
  parent: MockCaptionElement | null = null;
  text: string;
  disabled = false;
  // Mirrors the browser contract: detached clones lose layout, so innerText
  // falls back to concatenated textContent with no block separators.
  detached = false;

  constructor(tagName = "div", textContent = "", attributes: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase();
    this.text = textContent;
    this.attributes = attributes;
  }

  toJSON() {
    return {};
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  matches(selector: string): boolean {
    const parts = selector
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    for (const part of parts) {
      if (part === "button" && this.tagName === "BUTTON") {
        return true;
      }
      if (part === '[role="button"]' && this.getAttribute("role") === "button") {
        return true;
      }
      if (
        (part === "i.material-icons" || part === "i.material-icons-extended") &&
        this.tagName === "I"
      ) {
        return true;
      }
      if (part === '[aria-hidden="true"]' && this.getAttribute("aria-hidden") === "true") {
        return true;
      }
    }
    return false;
  }

  get textContent(): string {
    if (this.childNodes.length > 0) {
      // Real textContent concatenates descendant text with no block separators,
      // preserving direct text nodes alongside nested elements in DOM order.
      return this.childNodes.map((child) => child.textContent).join("");
    }
    if (this.children.length === 0) {
      return this.text;
    }
    // Real textContent concatenates descendant text with no block separators.
    return this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.text = value;
    this.children.length = 0;
    this.childNodes.length = 0;
  }

  get innerText(): string {
    if (this.children.length === 0) {
      return this.text;
    }
    // Attached nodes render block boundaries as newlines; detached clones do not.
    if (this.detached) {
      return this.textContent;
    }
    // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- Mock intentionally models layout-dependent innerText vs textContent.
    return this.children.map((child) => child.innerText).join("\n");
  }

  appendChild<T extends CaptionChild>(child: T): T {
    child.parent = this as unknown as MockCaptionElement;
    if ((child as MockCaptionElement).nodeType === 1) {
      this.children.push(child as unknown as MockCaptionElement);
    }
    this.childNodes.push(child);
    return child;
  }

  appendText(text: string): MockTextNode {
    return this.appendChild(new MockTextNode(text));
  }

  remove() {
    if (this.parent) {
      const childIdx = this.parent.children.indexOf(this);
      if (childIdx >= 0) {
        this.parent.children.splice(childIdx, 1);
      }
      const nodeIdx = (this.parent.childNodes as CaptionChild[]).indexOf(this);
      if (nodeIdx >= 0) {
        this.parent.childNodes.splice(nodeIdx, 1);
      }
      this.parent = null;
    }
  }

  cloneNode(deep = true): MockCaptionElement {
    const clone = new MockCaptionElement(this.tagName, this.text, { ...this.attributes });
    clone.detached = true;
    if (deep) {
      const source = this.childNodes.length > 0 ? this.childNodes : this.children;
      for (const child of source) {
        clone.appendChild(child.cloneNode(true) as CaptionChild);
      }
    }
    return clone;
  }

  querySelector(selector: string): MockCaptionElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector: string): MockCaptionElement[] {
    const matches: MockCaptionElement[] = [];
    const lower = selector.toLowerCase();
    const check = (node: MockCaptionElement) => {
      let matched = false;
      if (
        lower.includes("button") &&
        (node.tagName === "BUTTON" || node.getAttribute("role") === "button")
      ) {
        matched = true;
      } else if (lower.includes("material-icons") && node.tagName === "I") {
        matched = true;
      } else if (
        lower.includes('aria-hidden="true"') &&
        node.getAttribute("aria-hidden") === "true"
      ) {
        matched = true;
      }
      if (matched) {
        matches.push(node);
      }
      const kids = node.childNodes.length > 0 ? node.childNodes : (node.children as CaptionChild[]);
      for (const child of kids) {
        if ((child as MockCaptionElement).nodeType === 1) {
          check(child as MockCaptionElement);
        }
      }
    };
    const roots = this.childNodes.length > 0 ? this.childNodes : (this.children as CaptionChild[]);
    for (const child of roots) {
      if ((child as MockCaptionElement).nodeType === 1) {
        check(child as MockCaptionElement);
      }
    }
    return matches;
  }
}

function captionRegion(speaker: string, speech: string): MockCaptionElement {
  const region = new MockCaptionElement("div", "", { role: "region", "aria-label": "Captions" });
  if (speaker) {
    region.appendChild(new MockCaptionElement("div", speaker));
  }
  if (speech) {
    region.appendChild(new MockCaptionElement("div", speech));
  }
  return region;
}

function setupCaptionEnvironment(elements: MockCaptionElement[]) {
  const leaveButton = pageNode("Leave call");
  const windowState: Record<string, unknown> = {};
  const document = {
    body: new MockCaptionElement("body", ""),
    title: "Meet",
    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector: string) {
      if (selector === "button") {
        return [leaveButton];
      }
      if (selector === "input") {
        return [];
      }
      if (selector.includes("button") && !selector.includes("region")) {
        return [leaveButton];
      }
      return elements.filter((el) => {
        const role = el.getAttribute("role");
        const ariaLabel = el.getAttribute("aria-label");
        const ariaLive = el.getAttribute("aria-live");
        return selector
          .split(",")
          .map((part) => part.trim())
          .some((part) => {
            if (part.includes('role="region"') && role !== "region") {
              return false;
            }
            if (part.includes('aria-live="polite"') && ariaLive !== "polite") {
              return false;
            }
            if (
              part.includes('aria-label*="aption" i') &&
              (!ariaLabel || !/aption/i.test(ariaLabel))
            ) {
              return false;
            }
            return true;
          });
      });
    },
  };

  const runScript = async () => {
    return runInNewContext(
      `(${meetStatusScript({
        allowMicrophone: true,
        autoJoin: false,
        captureCaptions: true,
        captionSessionId: "test-session",
        guestName: "OpenClaw Agent",
        readOnly: true,
      })})()`,
      {
        Event: globalThis.Event,
        JSON,
        String,
        Date,
        clearTimeout: (id?: number | NodeJS.Timeout) => clearTimeout(id),
        setTimeout: (handler: () => void, timeout?: number) => setTimeout(handler, timeout),
        document,
        location: { href: MEETING_URL, hostname: "meet.google.com" },
        navigator: {
          mediaDevices: { enumerateDevices: async () => [] },
        },
        window: windowState,
        crypto: { randomUUID: () => "test-uuid" },
        MutationObserver: class {
          observe = vi.fn();
          disconnect = vi.fn();
        },
      },
    );
  };

  const runTranscriptScript = (finalize = false) => {
    return JSON.parse(
      runInNewContext(`(${meetTranscriptScript(MEETING_URL, "test-session", finalize)})()`, {
        JSON,
        URL,
        location: { href: MEETING_URL },
        window: windowState,
      }) as string,
    ) as {
      droppedLines: number;
      lines: Array<{ at: string; speaker?: string; text: string }>;
      sessionMatched: boolean;
      urlMatched: boolean;
    };
  };

  return { document, elements, leaveButton, runScript, runTranscriptScript, windowState };
}

function getCaptionState(env: ReturnType<typeof setupCaptionEnvironment>) {
  return env.windowState["__openclawMeetCaptions"] as {
    droppedLines: number;
    lines: Array<{ at: string; speaker?: string; text: string }>;
    visible: Array<{ at: string; node: unknown; seenAt: number; speaker?: string; text: string }>;
  };
}

describe("GOOGLE_MEET_PLATFORM_ADAPTER caption extraction and coalescing", () => {
  it("coalesces progressive staircase caption revisions into a single line", async () => {
    const region = new MockCaptionElement("div", "", {
      role: "region",
      "aria-label": "Captions",
    });
    const speaker = new MockCaptionElement("div", "Alice");
    const speech = new MockCaptionElement("div", "A movie.");
    region.appendChild(speaker);
    region.appendChild(speech);

    const env = setupCaptionEnvironment([region]);
    await env.runScript();

    const state = getCaptionState(env);
    expect(state.lines).toEqual([]);
    expect(state.visible.map((v) => v.text)).toEqual(["A movie."]);

    // Progressive revision 1
    speech.textContent = "A movie. Mo Vivo movie.";
    await env.runScript();
    expect(state.lines).toEqual([]);
    expect(state.visible.map((v) => v.text)).toEqual(["A movie. Mo Vivo movie."]);

    // Progressive revision 2
    speech.textContent = "A movie. Mo Vivo movie. What movie, the movie?";
    await env.runScript();
    expect(state.lines).toEqual([]);
    expect(state.visible.map((v) => v.text)).toEqual([
      "A movie. Mo Vivo movie. What movie, the movie?",
    ]);
  });

  it("updates non-prefix word corrections in-place without duplicate lines", async () => {
    const region = new MockCaptionElement("div", "", {
      role: "region",
      "aria-label": "Captions",
    });
    const speaker = new MockCaptionElement("div", "Alice");
    const speech = new MockCaptionElement("div", "We need fifteen");
    region.appendChild(speaker);
    region.appendChild(speech);

    const env = setupCaptionEnvironment([region]);
    await env.runScript();

    const state = getCaptionState(env);
    expect(state.lines).toEqual([]);
    expect(state.visible.map((v) => v.text)).toEqual(["We need fifteen"]);

    // Correction: speech model revised "fifteen" to "fifty"
    speech.textContent = "We need fifty";
    await env.runScript();
    expect(state.lines).toEqual([]);
    expect(state.visible.map((v) => v.text)).toEqual(["We need fifty"]);
  });

  it("ignores generic polite live notices from caption selection", async () => {
    const notice1 = new MockCaptionElement("div", "Live captions are on", {
      "aria-live": "polite",
    });
    const notice2 = new MockCaptionElement("div", "Your camera is off. Your microphone is off.", {
      "aria-live": "polite",
    });

    const env = setupCaptionEnvironment([notice1, notice2]);
    await env.runScript();

    const state = getCaptionState(env);
    expect(state.lines).toEqual([]);
    expect(state.visible).toEqual([]);
  });

  it("filters speaker-less participant notices inside caption regions", async () => {
    const region = new MockCaptionElement("div", "", {
      role: "region",
      "aria-label": "Captions",
    });
    const notice = new MockCaptionElement("div", "John Doe has left the meeting");
    region.appendChild(notice);

    const env = setupCaptionEnvironment([region]);
    await env.runScript();

    const state = getCaptionState(env);
    expect(state.lines).toEqual([]);
    expect(state.visible).toEqual([]);
  });

  it("preserves legitimate participant speech matching notice phrases", async () => {
    const region = new MockCaptionElement("div", "", {
      role: "region",
      "aria-label": "Captions",
    });
    const speaker = new MockCaptionElement("div", "Alice");
    const speech = new MockCaptionElement("div", "Your camera is off and you are muted");
    region.appendChild(speaker);
    region.appendChild(speech);

    const env = setupCaptionEnvironment([region]);
    await env.runScript();

    const state = getCaptionState(env);
    expect(state.lines).toEqual([]);
    expect(state.visible).toEqual([
      expect.objectContaining({
        speaker: "Alice",
        text: "Your camera is off and you are muted",
      }),
    ]);
  });

  it("strips 'Jump to bottom' buttons and icon ligatures from caption regions", async () => {
    const region = new MockCaptionElement("div", "", {
      role: "region",
      "aria-label": "Captions",
    });
    const button = new MockCaptionElement("button", "Jump to bottom", {
      role: "button",
    });
    const icon = new MockCaptionElement("i", "arrow_downward", {
      class: "material-icons",
      "aria-hidden": "true",
    });
    button.appendChild(icon);
    region.appendChild(button);

    const speaker = new MockCaptionElement("div", "Alice");
    const speech = new MockCaptionElement("div", "Hello everyone");
    region.appendChild(speaker);
    region.appendChild(speech);

    const env = setupCaptionEnvironment([region]);
    await env.runScript();

    const state = getCaptionState(env);
    expect(state.lines).toEqual([]);
    expect(state.visible).toEqual([
      expect.objectContaining({
        speaker: "Alice",
        text: "Hello everyone",
      }),
    ]);
  });

  it("commits finished speaker utterances when replaced by next speaker", async () => {
    const region1 = new MockCaptionElement("div", "", {
      role: "region",
      "aria-label": "Captions",
    });
    const speaker1 = new MockCaptionElement("div", "Alice");
    const speech1 = new MockCaptionElement("div", "Hello everyone");
    region1.appendChild(speaker1);
    region1.appendChild(speech1);

    const env = setupCaptionEnvironment([region1]);
    await env.runScript();

    const state = getCaptionState(env);
    expect(state.visible).toHaveLength(1);
    expect(state.lines).toHaveLength(0);

    // Alice finishes, Bob speaks in new region
    const region2 = new MockCaptionElement("div", "", {
      role: "region",
      "aria-label": "Captions",
    });
    const speaker2 = new MockCaptionElement("div", "Bob");
    const speech2 = new MockCaptionElement("div", "Hi Alice");
    region2.appendChild(speaker2);
    region2.appendChild(speech2);

    env.elements.length = 0;
    env.elements.push(region2);
    await env.runScript();

    expect(state.lines).toEqual([
      expect.objectContaining({
        speaker: "Alice",
        text: "Hello everyone",
      }),
    ]);
    expect(state.visible).toEqual([
      expect.objectContaining({
        speaker: "Bob",
        text: "Hi Alice",
      }),
    ]);
  });

  it("commits divergent same-node reuse instead of overwriting the prior utterance", async () => {
    const region = new MockCaptionElement("div", "", {
      role: "region",
      "aria-label": "Captions",
    });
    const speaker = new MockCaptionElement("div", "Alice");
    const speech = new MockCaptionElement("div", "We need fifteen volunteers");
    region.appendChild(speaker);
    region.appendChild(speech);

    const env = setupCaptionEnvironment([region]);
    await env.runScript();

    const state = getCaptionState(env);
    expect(state.visible.map((v) => v.text)).toEqual(["We need fifteen volunteers"]);

    // Same container reused for a divergent utterance from the same speaker.
    speech.textContent = "Lets adjourn now everyone";
    await env.runScript();

    expect(state.lines).toEqual([
      expect.objectContaining({ speaker: "Alice", text: "We need fifteen volunteers" }),
    ]);
    expect(state.visible).toEqual([
      expect.objectContaining({ speaker: "Alice", text: "Lets adjourn now everyone" }),
    ]);
  });

  it("keeps speaker attribution when controls sit between speaker and speech", async () => {
    const region = new MockCaptionElement("div", "", {
      role: "region",
      "aria-label": "Captions",
    });
    const speaker = new MockCaptionElement("div", "Alice");
    const button = new MockCaptionElement("button", "Jump to bottom", { role: "button" });
    const icon = new MockCaptionElement("i", "arrow_downward", {
      class: "material-icons",
      "aria-hidden": "true",
    });
    button.appendChild(icon);
    const speech = new MockCaptionElement("div", "Hello everyone");
    region.appendChild(speaker);
    region.appendChild(button);
    region.appendChild(speech);

    const env = setupCaptionEnvironment([region]);
    await env.runScript();

    const state = getCaptionState(env);
    // With realistic textContent (no block newlines when detached), the old
    // clone+innerText path merged this into speaker-less "AliceHello everyone".
    expect(state.visible).toEqual([
      expect.objectContaining({ speaker: "Alice", text: "Hello everyone" }),
    ]);
  });

  it("strips nested icon ligatures inside the speech child", async () => {
    const region = new MockCaptionElement("div", "", {
      role: "region",
      "aria-label": "Captions",
    });
    const speaker = new MockCaptionElement("div", "Alice");
    const speech = new MockCaptionElement("div", "");
    const speechText = new MockCaptionElement("span", "Hello everyone");
    const icon = new MockCaptionElement("i", "arrow_downward", {
      class: "material-icons",
      "aria-hidden": "true",
    });
    speech.appendChild(speechText);
    speech.appendChild(icon);
    region.appendChild(speaker);
    region.appendChild(speech);

    const env = setupCaptionEnvironment([region]);
    await env.runScript();

    const state = getCaptionState(env);
    expect(state.visible).toEqual([
      expect.objectContaining({ speaker: "Alice", text: "Hello everyone" }),
    ]);
  });
  it("preserves direct text around nested caption elements", async () => {
    const region = new MockCaptionElement("div", "", {
      role: "region",
      "aria-label": "Captions",
    });
    region.appendChild(new MockCaptionElement("div", "Alice"));
    const speech = new MockCaptionElement("div", "");
    speech.appendText("We need ");
    speech.appendChild(new MockCaptionElement("span", "fifty"));
    speech.appendText(" volunteers");
    region.appendChild(speech);

    const env = setupCaptionEnvironment([region]);
    await env.runScript();

    expect(getCaptionState(env).visible).toEqual([
      expect.objectContaining({ speaker: "Alice", text: "We need fifty volunteers" }),
    ]);
  });

  it("commits overlapping same-speaker utterances instead of overwriting", async () => {
    const region = captionRegion("Alice", "We need fifteen volunteers");
    const env = setupCaptionEnvironment([region]);
    await env.runScript();
    expect(getCaptionState(env).visible.map((v) => v.text)).toEqual(["We need fifteen volunteers"]);

    // Same container, same speaker, shared words — but a new utterance, not a correction.
    const speech = region.childNodes[1] as MockCaptionElement;
    speech.textContent = "We need chairs tomorrow";
    await env.runScript();

    const state = getCaptionState(env);
    expect(state.lines).toEqual([
      expect.objectContaining({ speaker: "Alice", text: "We need fifteen volunteers" }),
    ]);
    expect(state.visible).toEqual([
      expect.objectContaining({ speaker: "Alice", text: "We need chairs tomorrow" }),
    ]);
  });

  it("returns serializable status JSON while captions are visible", async () => {
    const env = setupCaptionEnvironment([captionRegion("Alice", "Hello everyone")]);
    const raw = await env.runScript();
    const status = JSON.parse(String(raw)) as {
      recentTranscript: Array<{ speaker?: string; text: string }>;
    };
    expect(status.recentTranscript).toEqual([
      expect.objectContaining({ speaker: "Alice", text: "Hello everyone" }),
    ]);
    expect("node" in (status.recentTranscript[0] as Record<string, unknown>)).toBe(false);
  });

  it("collapses transient duplicate regions to the longest row", async () => {
    const oldRegion = captionRegion("Alice", "We need fifteen");
    const grownRegion = captionRegion("Alice", "We need fifteen volunteers");
    const env = setupCaptionEnvironment([oldRegion, grownRegion]);
    await env.runScript();

    const state = getCaptionState(env);
    expect(state.lines).toEqual([]);
    expect(state.visible.map((v) => v.text)).toEqual(["We need fifteen volunteers"]);
  });

  it("absorbs prefix growth on a replaced node within the settle window", async () => {
    const region = captionRegion("Alice", "We need fifteen");
    const env = setupCaptionEnvironment([region]);
    await env.runScript();

    const grown = captionRegion("Alice", "We need fifteen volunteers");
    env.elements.length = 0;
    env.elements.push(grown);
    await env.runScript();

    const state = getCaptionState(env);
    expect(state.lines).toEqual([]);
    expect(state.visible.map((v) => v.text)).toEqual(["We need fifteen volunteers"]);
  });

  it("commits earlier utterance and records a new line for repeated text on a replaced node beyond the settle window", async () => {
    const region1 = captionRegion("Alice", "Yes.");
    const env = setupCaptionEnvironment([region1]);
    await env.runScript();

    const state = getCaptionState(env);
    expect(state.visible.map((v) => v.text)).toEqual(["Yes."]);
    const priorVisible = state.visible[0];
    if (!priorVisible) {
      throw new Error("expected a visible caption");
    }
    priorVisible.seenAt -= 5_000;

    const region2 = captionRegion("Alice", "Yes.");
    env.elements.length = 0;
    env.elements.push(region2);
    await env.runScript();

    expect(state.lines).toEqual([expect.objectContaining({ speaker: "Alice", text: "Yes." })]);
    expect(state.visible.map((v) => v.text)).toEqual(["Yes."]);
  });

  it("preserves the longer caption when a matching row temporarily shrinks before disappearing", async () => {
    vi.useFakeTimers();
    try {
      const region = captionRegion("Alice", "We need fifteen volunteers");
      const env = setupCaptionEnvironment([region]);
      await env.runScript();

      const speech = region.children[1];
      if (!speech) {
        throw new Error("expected speech child");
      }
      speech.textContent = "We need fifteen";
      await env.runScript();

      const state = getCaptionState(env);
      expect(state.visible.map((v) => v.text)).toEqual(["We need fifteen volunteers"]);

      env.elements.length = 0;
      await env.runScript();

      vi.advanceTimersByTime(1_100);

      expect(state.lines).toEqual([
        expect.objectContaining({
          speaker: "Alice",
          text: "We need fifteen volunteers",
        }),
      ]);
      expect(state.visible).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the longer caption when a matching row temporarily shrinks before leave finalization", async () => {
    const region = captionRegion("Alice", "We need fifteen volunteers");
    const env = setupCaptionEnvironment([region]);
    await env.runScript();

    const speech = region.children[1];
    if (!speech) {
      throw new Error("expected speech child");
    }
    speech.textContent = "We need fifteen";
    await env.runScript();

    const transcript = env.runTranscriptScript(true);
    expect(transcript.lines).toEqual([
      expect.objectContaining({
        speaker: "Alice",
        text: "We need fifteen volunteers",
      }),
    ]);
    expect(getCaptionState(env).visible).toEqual([]);
  });
});
