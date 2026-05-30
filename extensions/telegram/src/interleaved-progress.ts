export const INTERLEAVED_LINE_MAX_CHARS = 200;

// Slow enough that concurrent Thinking edits stay below Telegram chat rate limits.
export const INTERLEAVED_TIMER_INTERVAL_MS = 20_000;

// Keep visible text under Telegram's 4096-char cap; the draft stream freezes after oversize renders.
export const INTERLEAVED_MESSAGE_MAX_CHARS = 3900;

export const INTERLEAVED_SPILL_OVERLAP_CHARS = 600;

export function computeInterleavedSpill(params: {
  body: string;
  offset: number;
  maxChars?: number;
  overlapChars?: number;
}): { offset: number; spilled: boolean } {
  const maxChars = params.maxChars ?? INTERLEAVED_MESSAGE_MAX_CHARS;
  const overlap = params.overlapChars ?? INTERLEAVED_SPILL_OVERLAP_CHARS;
  const offset = Math.max(0, Math.min(params.offset, params.body.length));
  if (params.body.length - offset <= maxChars) {
    return { offset, spilled: false };
  }
  let newOffset = Math.max(offset, params.body.length - overlap);
  const nl = params.body.indexOf("\n", newOffset);
  if (nl >= 0 && nl < params.body.length - 1) {
    newOffset = nl + 1;
  }
  // Single huge lines have no clean rollover point.
  if (newOffset <= offset) {
    newOffset = Math.max(offset, params.body.length - Math.min(overlap, maxChars));
  }
  return { offset: newOffset, spilled: newOffset > offset };
}

export function resolveInterleavedProgressEnabled(params: {
  toolProgressEnabled: boolean;
  configEnabled: boolean | undefined;
  hasReasoningLane: boolean;
}): boolean {
  return params.toolProgressEnabled && params.configEnabled === true && params.hasReasoningLane;
}

export function sanitizeInterleavedLine(
  line: string,
  maxChars: number = INTERLEAVED_LINE_MAX_CHARS,
): string {
  return line.replace(/\s+/gu, " ").trim().slice(0, maxChars);
}

export function stripReasoningHeader(formatted: string): string {
  return formatted.replace(/^Thinking\n\n/u, "");
}

export function renderInterleavedMessage(params: {
  body: string;
  timerStartedAt?: number;
  now?: number;
  maxChars?: number;
}): string {
  const now = params.now ?? Date.now();
  let body = params.body.trimEnd();
  if (body === "" && params.timerStartedAt === undefined) {
    return "";
  }
  let timerSuffix = "";
  if (params.timerStartedAt !== undefined) {
    const elapsed = Math.floor((now - params.timerStartedAt) / 1000);
    const c = new Date(now);
    const pad2 = (n: number): string => String(n).padStart(2, "0");
    const clock = `${pad2(c.getHours())}:${pad2(c.getMinutes())}:${pad2(c.getSeconds())}`;
    timerSuffix = `\n_${elapsed}s — still running · ${clock}_`;
  }
  if (params.maxChars !== undefined) {
    const budget = params.maxChars - "Thinking\n\n".length - timerSuffix.length - 2;
    if (budget > 0 && body.length > budget) {
      const tail = body.slice(body.length - budget);
      const nl = tail.indexOf("\n");
      body = `…\n${nl >= 0 ? tail.slice(nl + 1) : tail}`;
    }
  }
  return `Thinking\n\n${body}${timerSuffix}`;
}

function stripLineItalics(text: string): string {
  return text
    .split("\n")
    .map((l) => (l.startsWith("_") && l.endsWith("_") && l.length > 1 ? l.slice(1, -1) : l))
    .join("\n");
}

export type InterleavedStreamState = { previousText: string; lastIncrement: string };

export function emptyInterleavedStreamState(): InterleavedStreamState {
  return { previousText: "", lastIncrement: "" };
}

export function appendInterleavedDelta(params: {
  body: string;
  state: InterleavedStreamState;
  text: string;
  delta?: string;
  replace?: boolean;
}): { body: string; state: InterleavedStreamState } {
  const { previousText, lastIncrement } = params.state;
  let increment: string;
  let nextPreviousText: string;
  if (typeof params.delta === "string") {
    increment = params.delta;
    nextPreviousText =
      params.text.length >= previousText.length ? params.text : previousText + params.delta;
  } else if (previousText !== "" && params.text.startsWith(previousText)) {
    increment = params.text.slice(previousText.length);
    nextPreviousText = params.text;
  } else {
    increment = params.text;
    nextPreviousText = params.text;
  }
  let body = params.body;
  if (params.replace === true && lastIncrement !== "" && body.endsWith(lastIncrement)) {
    body = body.slice(0, body.length - lastIncrement.length);
  } else {
    // Fold duplicate prose from separate streams before appending the new increment.
    increment = dropBodyTailOverlap(body, increment);
  }
  if (increment === "") {
    return { body, state: { previousText: nextPreviousText, lastIncrement } };
  }
  return {
    body: body + increment,
    state: { previousText: nextPreviousText, lastIncrement: increment },
  };
}

const INTERLEAVED_MIN_PARTIAL_OVERLAP = 10;

function dropBodyTailOverlap(body: string, increment: string): string {
  if (!increment) {
    return increment;
  }
  const lines = body.split("\n");
  const proseLines: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\[\d/u.test(lines[i]?.trimStart() ?? "")) {
      break;
    }
    proseLines.unshift(lines[i] ?? "");
  }
  const tail = proseLines.join("\n");
  if (!tail) {
    return increment;
  }
  if (tail.endsWith(increment)) {
    return "";
  }
  if (increment.startsWith(tail)) {
    return increment.slice(tail.length);
  }
  if (increment.length < INTERLEAVED_MIN_PARTIAL_OVERLAP) {
    return increment;
  }
  const maxK = Math.min(tail.length, increment.length);
  for (let k = maxK; k >= INTERLEAVED_MIN_PARTIAL_OVERLAP; k -= 1) {
    if (k < increment.length) {
      const before = increment[k - 1] ?? "";
      const after = increment[k] ?? "";
      if (/\w/u.test(before) && /\w/u.test(after)) {
        continue;
      }
    }
    if (tail.endsWith(increment.slice(0, k))) {
      return increment.slice(k);
    }
  }
  return increment;
}

export function appendStatusLine(params: {
  body: string;
  line: string;
  timestamp: string;
  previousLine?: string;
  maxChars?: number;
}): { body: string; appendedLine: string | undefined } {
  const text = sanitizeInterleavedLine(params.line, params.maxChars);
  if (!text || text === params.previousLine) {
    return { body: params.body, appendedLine: undefined };
  }
  return {
    body: `${params.body}\n[${params.timestamp}] ${text}\n`,
    appendedLine: text,
  };
}

function normaliseForDedup(text: string): string {
  return stripLineItalics(text).replace(/\s+/gu, " ").trim();
}

export function stripFinalAnswerFromInterleavedBody(params: {
  body: string;
  finalText: string;
}): string {
  const target = normaliseForDedup(params.finalText);
  if (!target) {
    return params.body;
  }
  const lines = params.body.split("\n");
  for (let start = lines.length - 1; start >= 0; start -= 1) {
    if (/^\[\d/u.test(lines[start]?.trimStart() ?? "")) {
      break;
    }
    const candidate = normaliseForDedup(lines.slice(start).join("\n"));
    if (candidate === target) {
      return lines.slice(0, start).join("\n").trimEnd();
    }
    if (candidate.length > target.length) {
      break;
    }
  }
  return params.body;
}

export function resolveInterleavedToolLine(params: {
  showArgs: boolean;
  sanitizedLine: string | undefined;
  toolName: string | undefined;
}): string {
  const nameOnly = params.toolName ? `tool: ${params.toolName}` : "tool running";
  return params.showArgs && params.sanitizedLine ? params.sanitizedLine : nameOnly;
}
