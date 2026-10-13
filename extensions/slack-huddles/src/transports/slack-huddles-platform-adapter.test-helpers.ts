import { runInNewContext } from "node:vm";
import { SLACK_HUDDLES_PLATFORM_ADAPTER } from "./slack-huddles-platform-adapter.js";

const HUDDLE_URL = "https://app.slack.com/huddle/T0123ABCD/C0123ABCD";
export const CLIENT_URL = "https://app.slack.com/client/T0123ABCD/C0123ABCD";

/** A small DOM fixture: selectors resolve actual attributes and parent/child relationships. */
export class PageNode {
  readonly children: PageNode[] = [];
  parentElement?: PageNode;
  isConnected = true;
  disabled = false;
  clicks = 0;
  onClick?: () => void;

  constructor(
    readonly tagName: string,
    readonly attributes: Record<string, string> = {},
    private content = "",
  ) {}

  get textContent(): string {
    return this.content + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.content = value;
    this.children.splice(0);
  }

  get nextElementSibling(): PageNode | undefined {
    const siblings = this.parentElement?.children;
    return siblings?.[siblings.indexOf(this) + 1];
  }

  append(...nodes: PageNode[]): this {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  click(): void {
    this.clicks += 1;
    this.onClick?.();
  }

  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      let remaining = part.trim();
      const requiredChildren = [...remaining.matchAll(/:has\(>\s*([^)]*)\)/g)];
      for (const [, childSelector] of requiredChildren) {
        if (!childSelector || !this.children.some((child) => child.matches(childSelector))) {
          return false;
        }
      }
      remaining = remaining.replace(/:has\(>\s*[^)]*\)/g, "");
      const sibling = remaining.match(/:has\(\+\s*([^)]*)\)$/);
      if (sibling) {
        if (!sibling[1] || !this.nextElementSibling?.matches(sibling[1])) {
          return false;
        }
        remaining = remaining.slice(0, sibling.index);
      }
      const attributes = [
        ...remaining.matchAll(/\[([\w-]+)(?:(\^=|\*=|=)"([^"]*)"(?:\s+(i))?)?\]/g),
      ];
      for (const [, name, operator, expected, ignoreCase] of attributes) {
        if (!name) {
          return false;
        }
        let actual = this.getAttribute(name);
        if (actual === null) {
          return false;
        }
        if (!operator) {
          continue;
        }
        if (expected === undefined) {
          return false;
        }
        const wanted = ignoreCase ? expected.toLowerCase() : expected;
        if (ignoreCase) {
          actual = actual.toLowerCase();
        }
        if (operator === "=" && actual !== wanted) {
          return false;
        }
        if (operator === "^=" && !actual.startsWith(wanted)) {
          return false;
        }
        if (operator === "*=" && !actual.includes(wanted)) {
          return false;
        }
      }
      remaining = remaining.replace(/\[[^\]]*\]/g, "");
      const classes = [...remaining.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
      if (
        classes.some((name) => !name || !(this.attributes.class ?? "").split(/\s+/).includes(name))
      ) {
        return false;
      }
      remaining = remaining.replace(/\.[\w-]+/g, "");
      const id = remaining.match(/#([\w-]+)/);
      if (id && this.getAttribute("id") !== id[1]) {
        return false;
      }
      remaining = remaining.replace(/#[\w-]+/g, "");
      return (
        remaining === "" ||
        remaining === "*" ||
        remaining.toLowerCase() === this.tagName.toLowerCase()
      );
    });
  }

  closest(selector: string): PageNode | undefined {
    return this.matches(selector) ? this : this.parentElement?.closest(selector);
  }

  querySelectorAll(selector: string): PageNode[] {
    const candidates = this.descendants();
    return candidates.filter((candidate) =>
      selector.split(",").some((part) => {
        const descendant = part.trim().match(/^(.*?)\s+(?=[a-z.#])([^ ]+)$/);
        if (!descendant?.[1] || !descendant[2] || part.includes(":has(")) {
          return candidate.matches(part);
        }
        if (!candidate.matches(descendant[2])) {
          return false;
        }
        for (
          let parent = candidate.parentElement;
          parent && parent !== this.parentElement;
          parent = parent.parentElement
        ) {
          if (parent.matches(descendant[1])) {
            return true;
          }
        }
        return false;
      }),
    );
  }

  querySelector(selector: string): PageNode | undefined {
    return this.querySelectorAll(selector)[0];
  }

  private descendants(): PageNode[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

export function qaNode(qa: string, text = "", tag = "button"): PageNode {
  return new PageNode(tag, { "data-qa": qa }, text);
}

export function microphone(on: boolean, inPreview = false): PageNode {
  const node = new PageNode("button", {
    "data-qa": inPreview ? "huddle_join_preview_mic_button" : "huddle_sidebar_footer_mute_button",
    role: "switch",
    "aria-label": "Microphone",
    "aria-checked": String(on),
  });
  node.onClick = () =>
    node.setAttribute("aria-checked", String(node.getAttribute("aria-checked") !== "true"));
  return node;
}

export function page(...nodes: PageNode[]) {
  const body = new PageNode("body").append(...nodes);
  return {
    body,
    title: "Slack",
    querySelector: (selector: string) =>
      body.matches(selector) ? body : body.querySelector(selector),
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    getElementById: () => undefined,
  };
}

export function fixture(params: {
  document: ReturnType<typeof page>;
  currentUrl?: string;
  window?: Record<string, unknown>;
  /** Seeds the marker a completed Join click leaves behind. */
  joined?: boolean;
  /** Runs inside the shared runtime's awaited device enumeration. */
  onEnumerateDevices?: () => void;
  devices?: { kind: string; label: string; deviceId: string }[];
  /** Adds a microphone permission query and runs this inside its await. */
  onPermissionQuery?: () => void;
}) {
  const window =
    params.window ??
    (params.joined
      ? {
          __openclawSlackHuddle: {
            identity: "slack-huddle:T0123ABCD:C0123ABCD",
            sessionId: "session-1",
            joinRequested: true,
          },
        }
      : {});
  const location = new URL(params.currentUrl ?? HUDDLE_URL);
  let mutation: (() => void) | undefined;
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const sandbox = {
    URL,
    document: params.document,
    location,
    window,
    crypto: { randomUUID: () => "slack-caption-epoch" },
    // Capture setup past the ownership check is the shared runtime's concern; stop there.
    AudioContext: function AudioContext() {
      throw new Error("audio capture passed ownership");
    },
    navigator: {
      ...(params.onPermissionQuery
        ? {
            permissions: {
              query: async () => {
                params.onPermissionQuery?.();
                return { state: "granted" };
              },
            },
          }
        : {}),
      mediaDevices: {
        enumerateDevices: async () => {
          params.onEnumerateDevices?.();
          return params.devices ?? [];
        },
      },
    },
    MutationObserver: class {
      constructor(callback: () => void) {
        mutation = callback;
      }
      observe() {}
      disconnect() {
        mutation = undefined;
      }
    },
    setTimeout(callback: () => void, delay: number) {
      const id = nextTimer++;
      // Shared UI settling awaits one microtask; caption settlement remains explicitly driven.
      if (delay === 120) {
        queueMicrotask(callback);
      } else {
        timers.set(id, callback);
      }
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
  };
  return {
    window,
    location,
    mutate: () => mutation?.(),
    async status(
      overrides: Partial<
        Parameters<typeof SLACK_HUDDLES_PLATFORM_ADAPTER.browser.buildStatusJoinScript>[0]
      > = {},
    ) {
      const source = SLACK_HUDDLES_PLATFORM_ADAPTER.browser.buildStatusJoinScript({
        allowSessionAdoption: true,
        autoJoin: true,
        captureCaptions: false,
        guestName: "OpenClaw Agent",
        meetingSessionId: "session-1",
        mode: "transcribe",
        url: HUDDLE_URL,
        waitForInCallMs: 60_000,
        ...overrides,
      });
      const result = await runInNewContext(`(${source})()`, sandbox);
      return JSON.parse(result) as Record<string, unknown>;
    },
    leave(leaveInitiated = false, meetingUrl = HUDDLE_URL) {
      const source = SLACK_HUDDLES_PLATFORM_ADAPTER.browser.buildSessionLeaveScript?.({
        leaveInitiated,
        meetingSessionId: "session-1",
        meetingUrl,
      });
      if (!source) {
        throw new Error("Missing session-owned leave script");
      }
      return JSON.parse(runInNewContext(`(${source})()`, sandbox)) as Record<string, unknown>;
    },
    startAudioCapture() {
      const source = SLACK_HUDDLES_PLATFORM_ADAPTER.browser.buildAudioCaptureScript?.({
        action: "start",
        captureId: "capture-1",
        meetingSessionId: "session-1",
        meetingUrl: HUDDLE_URL,
      });
      if (!source) {
        throw new Error("Missing audio capture script");
      }
      return runInNewContext(`(${source})()`, sandbox) as Promise<string>;
    },
    transcript(finalize = false) {
      const source = SLACK_HUDDLES_PLATFORM_ADAPTER.browser.captions.buildTranscriptScript({
        finalize,
        meetingSessionId: "session-1",
        meetingUrl: HUDDLE_URL,
      });
      return JSON.parse(runInNewContext(`(${source})()`, sandbox)) as Record<string, unknown>;
    },
  };
}

export function preview(label: string, micOn = false, fallback = false) {
  const join = fallback
    ? new PageNode("button", {}, label)
    : qaNode("huddle_join_preview_modal_go", label);
  const mic = microphone(micOn, true);
  const modal = qaNode("huddle_join_preview_modal", "", "div").append(mic, join);
  return { document: page(modal), join, mic };
}

/** An in-call page; `member` renders Slack's header proof that this device is in the channel's huddle. */
export function inCall(
  marker = qaNode("huddle_toolbar__leave_button", "Leave Huddle"),
  micOn = false,
  member = true,
) {
  const mic = microphone(micOn);
  const nodes = member ? [marker, mic, channelHeader(true)] : [marker, mic];
  return { document: page(...nodes), marker, mic };
}

export function channelHeader(inHuddle: boolean) {
  const classes = ["p-huddle_channel_header_button__container"];
  if (inHuddle) {
    classes.push("p-huddle_channel_header_button--in_huddle");
  }
  return new PageNode("div", {
    class: classes.join(" "),
    "data-qa": "huddle_channel_header_button",
  });
}
