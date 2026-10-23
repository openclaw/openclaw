import { createContext, Script } from "node:vm";
import type {
  MeetingTranscriptLine as CaptionLine,
  MeetingTranscriptSnapshot,
} from "openclaw/plugin-sdk/meeting-runtime";
import { assert, expect } from "vitest";
import { meetTranscriptScript } from "./google-meet-caption-scripts.js";
import { meetStatusScript } from "./google-meet-page-scripts.js";

const MEETING_URL = "https://meet.google.com/abc-defg-hij";
type Transcript = Required<MeetingTranscriptSnapshot> & { sessionMatched: boolean };

export class CaptionNode {
  constructor(
    public textContent: string,
    private attributes: Record<string, string> = {},
    public parentElement: CaptionNode | null = null,
  ) {}

  get innerText() {
    return this.textContent;
  }

  getAttribute = (name: string) => this.attributes[name] ?? null;

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  closest(selector: string): CaptionNode | null {
    if (selector !== "[data-is-self]") {
      return null;
    }
    return this.getAttribute("data-is-self") !== null
      ? this
      : (this.parentElement?.closest(selector) ?? null);
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
  const leaveButton = new CaptionNode("", { "aria-label": "Leave call" });
  const context = createContext({
    Date: Object.assign(class extends Date {}, { now: () => now }),
    URL,
    crypto: { randomUUID: () => `epoch-${++nextEpoch}` },
    document: {
      body: { innerText: "Meeting in progress" },
      title: "Meet",
      querySelector: (selector: string) =>
        selector.includes("aria-live") ? (rows[0] ?? null) : null,
      querySelectorAll: (selector: string) =>
        selector === "button" ? [leaveButton] : selector.includes("aria-live") ? rows : [],
    },
    location: { href: MEETING_URL, hostname: "meet.google.com" },
    MutationObserver: class {
      constructor(private callback: () => void) {}

      observe = (_target: unknown, options: { attributes?: boolean; attributeFilter?: string[] }) =>
        observers.set(this.callback, options);
      disconnect = () => observers.delete(this.callback);
    },
    setTimeout: (callback: () => void, delay: number) => {
      timers.set(++nextTimer, { callback, delay });
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
    window: windowState,
  });
  const run = (script: string) =>
    (new Script(`(${script})`).runInContext(context) as () => unknown)();
  return {
    async poll(sessionId = "session-1") {
      await run(
        meetStatusScript({
          allowMicrophone: false,
          autoJoin: false,
          captionSessionId: sessionId,
          captureCaptions: true,
          guestName: "Meeting Assistant",
          readOnly: true,
        }),
      );
    },
    read: (finalize = false, sessionId = "session-1") =>
      JSON.parse(
        run(meetTranscriptScript(MEETING_URL, sessionId, finalize)) as string,
      ) as Transcript,
    show(nextRows: CaptionNode[]) {
      rows = nextRows;
      observers.forEach((_options, notify) => notify());
    },
    markSelf(row: CaptionNode, marker: string) {
      row.setAttribute("data-is-self", marker);
      for (const [notify, options] of observers) {
        if (options.attributes && options.attributeFilter?.includes("data-is-self")) {
          notify();
        }
      }
    },
    advance: (milliseconds: number) => (now += milliseconds),
    settle() {
      expect(timers.size).toBeGreaterThan(0);
      // Callbacks may schedule another timer; settle only the current snapshot.
      for (const [id, timer] of Array.from(timers)) {
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
  const line = lines[0];
  assert(lines.length === 1 && line, "Expected one captured caption");
  return line;
}

export function onlySourcedLine(lines: CaptionLine[]) {
  const line = onlyLine(lines);
  assert(line.source, "Expected caption source identity");
  return { ...line, source: line.source };
}
