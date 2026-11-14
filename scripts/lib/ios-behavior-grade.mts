// Turns the iOS chat probe log (`behavior-probe.jsonl`, see ChatBehaviorProbe.swift) into
// metrics for `pnpm ios:behavior`. Pure functions so cases and tests share one reading.

export type ProbeFrame = { t: number; f: Record<string, [number, number]> };
export type ProbeEvent = { t: number; e: string; k?: string; v?: string };
export type ProbeLog = { frames: ProbeFrame[]; events: ProbeEvent[] };

/** Fastest real fling step is about 8000 pt/s at 60 Hz; a bigger one-frame move is a jump. */
const TELEPORT_PT = 400;
/** Sub-point moves are rounding between layout passes, not motion a reader sees. */
const STILL_PT = 0.5;

export function parseProbeLog(text: string): ProbeLog {
  const frames: ProbeFrame[] = [];
  const events: ProbeEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const entry = JSON.parse(line) as ProbeFrame & ProbeEvent;
    if (entry.f) {
      frames.push(entry);
    } else {
      events.push(entry);
    }
  }
  return { frames, events };
}

/** User drags and their deceleration: frames inside these windows are the reader's own motion. */
function userScrollWindows(events: ProbeEvent[]): Array<[number, number]> {
  const windows: Array<[number, number]> = [];
  let start: number | undefined;
  for (const event of events) {
    if (event.e !== "phase") {
      continue;
    }
    if (event.v === "interacting" && start === undefined) {
      start = event.t;
    } else if (event.v === "idle" && start !== undefined) {
      windows.push([start, event.t]);
      start = undefined;
    }
  }
  if (start !== undefined) {
    windows.push([start, Number.POSITIVE_INFINITY]);
  }
  return windows;
}

/**
 * Frames and events between `from` and `to`, minus the reader's own scrolling. The probe writes a
 * frame only when something moved, so the last frame before `from` is the layout at `from`; it
 * leads the window so a jump in the first frame inside it is measured.
 */
export function window(log: ProbeLog, from: number, to: number): ProbeLog {
  const scrolling = userScrollWindows(log.events);
  const userMoved = (t: number) => scrolling.some(([start, end]) => t >= start && t <= end);
  const inside = log.frames.filter(
    (frame) => frame.t >= from && frame.t <= to && !userMoved(frame.t),
  );
  const atStart = userMoved(from) ? undefined : log.frames.findLast((frame) => frame.t < from);
  return {
    frames: atStart ? [atStart, ...inside] : inside,
    events: log.events.filter((event) => event.t >= from && event.t <= to),
  };
}

const isRow = (key: string) => key !== "composer";

type Edges = [number, number];

/** Whether any part of the row is between the top of the screen and the composer. */
const rowOnScreen = ([top, bottom]: Edges, visibleBottom: number) =>
  bottom > 0 && top < visibleBottom;

/**
 * How far a row moved between two recorded positions, as the reader saw it. Undefined when the
 * row was off screen in both: rows mounted above the fold shift when an earlier height changes.
 * A row that kept its height moved as a whole, including a long reply spanning the screen. When
 * the height changed, read an edge the reader can see: the top when it is on screen in both, else
 * the bottom. Replies grow taller than the screen; their off-screen top can move thousands of
 * points while the visible text holds still. Undefined when neither edge is visible in both.
 */
function visibleShift(before: Edges, after: Edges, visibleBottom: number) {
  if (!rowOnScreen(before, visibleBottom) && !rowOnScreen(after, visibleBottom)) {
    return undefined;
  }
  const top = after[0] - before[0];
  if (Math.abs(after[1] - before[1] - top) <= STILL_PT) {
    return top;
  }
  const onScreen = (y: number) => y >= 0 && y <= visibleBottom;
  if (onScreen(before[0]) && onScreen(after[0])) {
    return top;
  }
  if (onScreen(before[1]) && onScreen(after[1])) {
    return after[1] - before[1];
  }
  return undefined;
}

/**
 * How tagged rows moved between consecutive recorded frames. Any downward step counts as backward
 * motion. A key in `aliases` continues the key it maps to (the final message row replacing the
 * live bubble); in the frame where both exist, the outgoing one is already leaving and is ignored.
 */
export function motion(
  frames: ProbeFrame[],
  options: { aliases?: Record<string, string> } = {},
): { teleports: number; backwardPt: number; largestStepPt: number; maxDriftPt: number } {
  const aliases = options.aliases ?? {};
  const rows = (frame: ProbeFrame) => {
    const edges = new Map<string, Edges>();
    const replaced = new Set(
      Object.keys(frame.f).flatMap((key) => (aliases[key] ? [aliases[key]] : [])),
    );
    for (const [key, rect] of Object.entries(frame.f)) {
      if (isRow(key) && !replaced.has(key)) {
        edges.set(aliases[key] ?? key, rect);
      }
    }
    return edges;
  };
  let teleports = 0;
  let backwardPt = 0;
  let largestStepPt = 0;
  let maxDriftPt = 0;
  const firstSeen = new Map<string, Edges>();
  let previous: Map<string, Edges> | undefined;
  for (const frame of frames) {
    // Rows below the composer's top are hidden behind it.
    const visibleBottom = frame.f.composer?.[0] ?? Number.POSITIVE_INFINITY;
    const current = rows(frame);
    for (const [key, edges] of current) {
      const first = firstSeen.get(key) ?? edges;
      firstSeen.set(key, first);
      maxDriftPt = Math.max(maxDriftPt, Math.abs(visibleShift(first, edges, visibleBottom) ?? 0));
    }
    if (previous) {
      let stepBackward = 0;
      for (const [key, edges] of current) {
        const before = previous.get(key);
        if (!before) {
          continue;
        }
        // A jump moves both edges; a reply finishing or growing moves only one.
        const top = edges[0] - before[0];
        const bottom = edges[1] - before[1];
        if (
          (rowOnScreen(before, visibleBottom) || rowOnScreen(edges, visibleBottom)) &&
          Math.sign(top) === Math.sign(bottom) &&
          Math.min(Math.abs(top), Math.abs(bottom)) > TELEPORT_PT
        ) {
          teleports += 1;
        }
        const dy = visibleShift(before, edges, visibleBottom);
        if (dy === undefined) {
          continue;
        }
        largestStepPt = Math.max(largestStepPt, Math.abs(dy));
        if (dy > STILL_PT) {
          stepBackward = Math.max(stepBackward, dy);
        }
      }
      backwardPt += stepBackward;
    }
    previous = current;
  }
  return {
    teleports,
    backwardPt: round(backwardPt),
    largestStepPt: round(largestStepPt),
    maxDriftPt: round(maxDriftPt),
  };
}

/**
 * Mounts between `from` and `to` of a row that had already mounted earlier in the log: SwiftUI
 * rebuilt it from scratch. Takes the whole log's events, so rows mounted before the window count.
 */
export function remounts(
  events: ProbeEvent[],
  from = Number.NEGATIVE_INFINITY,
  to = Number.POSITIVE_INFINITY,
) {
  const mounted = new Set<string>();
  let count = 0;
  for (const event of events) {
    if (event.e !== "mount" || !event.k || !isRow(event.k) || event.t > to) {
      continue;
    }
    if (event.t >= from && mounted.has(event.k)) {
      count += 1;
    }
    mounted.add(event.k);
  }
  return count;
}

export function bodyCounts(events: ProbeEvent[]) {
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (event.e === "body" && event.k) {
      counts[event.k] = (counts[event.k] ?? 0) + 1;
    }
  }
  return counts;
}

export function firstEvent(events: ProbeEvent[], predicate: (event: ProbeEvent) => boolean) {
  return events.find(predicate)?.t;
}

export function firstFrame(frames: ProbeFrame[], predicate: (frame: ProbeFrame) => boolean) {
  return frames.find(predicate)?.t;
}

/** Gap between the lowest row bottom above the composer and the composer top. */
export function composerGap(frame: ProbeFrame | undefined) {
  const composer = frame?.f.composer;
  if (!frame || !composer) {
    return undefined;
  }
  const bottoms = Object.entries(frame.f)
    .filter(([key, [, maxY]]) => isRow(key) && maxY <= composer[0] + 1)
    .map(([, [, maxY]]) => maxY);
  return bottoms.length > 0 ? round(composer[0] - Math.max(...bottoms)) : undefined;
}

/** How far the lowest row reaches below the composer top: content the reader cannot see. */
export function hiddenBelowComposer(frame: ProbeFrame | undefined) {
  const composer = frame?.f.composer;
  if (!frame || !composer) {
    return undefined;
  }
  const bottoms = Object.entries(frame.f)
    .filter(([key]) => isRow(key))
    .map(([, [, maxY]]) => maxY);
  return bottoms.length > 0 ? round(Math.max(0, Math.max(...bottoms) - composer[0])) : undefined;
}

export function lastFrameBefore(frames: ProbeFrame[], t: number) {
  return frames.findLast((frame) => frame.t <= t);
}

export function percentile(values: number[], p: number) {
  const sorted = values.toSorted((a, b) => a - b);
  const value = sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return value === undefined ? undefined : round(value);
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
