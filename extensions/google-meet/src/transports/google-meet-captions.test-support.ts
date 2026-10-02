import { createContext, Script } from "node:vm";
import type {
  MeetingTranscriptLine,
  MeetingTranscriptSnapshot,
} from "openclaw/plugin-sdk/meeting-runtime";
import { expect } from "vitest";
import { meetTranscriptScript } from "./google-meet-caption-scripts.js";
import { meetStatusScript } from "./google-meet-page-scripts.js";

const MEETING_URL = "https://meet.google.com/abc-defg-hij";
export const GUEST_NAME = "Meeting Assistant";
type CaptionLine = MeetingTranscriptLine;
type CaptionSource = NonNullable<MeetingTranscriptLine["source"]>;
type Transcript = MeetingTranscriptSnapshot & {
  sessionMatched: boolean;
  epoch: string;
  pendingLines: MeetingTranscriptLine[];
};

export class CaptionNode {
  constructor(
    public textContent: string,
    private attributes: Record<string, string> = {},
    public parentElement: CaptionNode | null = null,
  ) {}

  get innerText() {
    return this.textContent;
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  closest(selector: string): CaptionNode | null {
    return closestCaptionNode(this, selector);
  }
}

export function createCaptionPage(initialRows: CaptionNode[]) {
  let rows = initialRows;
  let now = 1_000;
  let nextTimer = 0;
  let nextEpoch = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const observers = new Map<() => void, { attributes?: boolean; attributeFilter?: string[] }>();
  const windowState: Record<string, unknown> = {};
  const leaveButton = {
    disabled: false,
    innerText: "",
    getAttribute: (name: string) => (name === "aria-label" ? "Leave call" : null),
  };
  const context = createContext({
    Date: class extends Date {
      static override now() {
        return now;
      }
    },
    URL,
    crypto: { randomUUID: () => `epoch-${++nextEpoch}` },
    document: {
      body: { innerText: "Meeting in progress" },
      title: "Meet",
      querySelector: (selector: string) =>
        selector.includes("aria-live") ? (rows[0] ?? null) : null,
      querySelectorAll: (selector: string) => {
        if (selector === "button") {
          return [leaveButton];
        }
        return selector.includes("aria-live") ? rows : [];
      },
    },
    location: { href: MEETING_URL, hostname: "meet.google.com" },
    MutationObserver: class {
      constructor(private callback: () => void) {}

      observe(_target: unknown, options: { attributes?: boolean; attributeFilter?: string[] }) {
        observers.set(this.callback, options);
      }

      disconnect() {
        observers.delete(this.callback);
      }
    },
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    window: windowState,
  });
  return {
    async poll(sessionId = "session-1") {
      const inspect = new Script(
        `(${meetStatusScript({
          allowMicrophone: false,
          autoJoin: false,
          captionSessionId: sessionId,
          captureCaptions: true,
          guestName: GUEST_NAME,
          readOnly: true,
        })})`,
      ).runInContext(context) as () => Promise<string>;
      await inspect();
    },
    read(finalize = false, sessionId = "session-1"): Transcript {
      const read = new Script(
        `(${meetTranscriptScript(MEETING_URL, sessionId, finalize)})`,
      ).runInContext(context) as () => string;
      return JSON.parse(read()) as Transcript;
    },
    show(nextRows: CaptionNode[]) {
      rows = nextRows;
      for (const notify of observers.keys()) {
        notify();
      }
    },
    markSelf(row: CaptionNode, marker: string) {
      row.setAttribute("data-is-self", marker);
      for (const [notify, options] of observers) {
        if (options.attributes && options.attributeFilter?.includes("data-is-self")) {
          notify();
        }
      }
    },
    advance(milliseconds: number) {
      now += milliseconds;
    },
    settle() {
      expect(timers.size).toBeGreaterThan(0);
      // Callbacks may schedule another timer; settle only the current snapshot.
      const pendingTimers = Array.from(timers);
      for (const [id, timer] of pendingTimers) {
        timers.delete(id);
        now += timer.delay;
        timer.callback();
      }
    },
    reload() {
      timers.clear();
      observers.clear();
      delete windowState["__openclawMeetCaptions"];
    },
  };
}

export function onlyLine(lines: CaptionLine[]): CaptionLine {
  expect(lines).toHaveLength(1);
  const line = lines[0];
  if (!line) {
    throw new Error("Expected one captured caption");
  }
  return line;
}

export function onlySourcedLine(lines: CaptionLine[]): CaptionLine & { source: CaptionSource } {
  const line = onlyLine(lines);
  if (!line.source) {
    throw new Error("Expected caption source identity");
  }
  return { ...line, source: line.source };
}

function closestCaptionNode(startNode: CaptionNode | null, selector: string): CaptionNode | null {
  for (let node = startNode; node; node = node.parentElement) {
    if (selector === "[data-is-self]" && node.getAttribute("data-is-self") !== null) {
      return node;
    }
  }
  return null;
}
