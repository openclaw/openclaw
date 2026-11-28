import { RUNTIME_CONTEXT_FOOTER, RUNTIME_CONTEXT_HEADER } from "../llm/types.js";
import { escapeRegExp } from "../shared/regexp.js";
import type { TextFilter, TextProjector } from "../shared/text/text-projection.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  INTERNAL_RUNTIME_CONTEXT_EVENT_PREFIX,
  OPENCLAW_RUNTIME_CONTEXT_NOTICE,
  RUNTIME_CONTEXT_PROMPT_HEADERS,
  stripInternalRuntimeContext,
} from "./internal-runtime-context.js";

// Complete generated delimiters avoid activating on ordinary prose.
const STREAM_DELIMITERS = [
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  RUNTIME_CONTEXT_HEADER,
] as const;
const STREAM_DELIMITERS_LOWER = STREAM_DELIMITERS.map((token) => token.toLowerCase());
const STREAM_SCAN_LENGTH = 96;
const NORMALIZED_CURRENT_HEADER = normalizeScan(RUNTIME_CONTEXT_HEADER).trimStart();
const EVENT_PREFIX_FAILURE = buildPrefixFailure(INTERNAL_RUNTIME_CONTEXT_EVENT_PREFIX);
const NORMALIZED_RUNTIME_NOTICE = normalizeScan(OPENCLAW_RUNTIME_CONTEXT_NOTICE).trim();
const CARRIER_HEADERS = RUNTIME_CONTEXT_PROMPT_HEADERS.flatMap((header) => {
  const sentences = header.split(". ");
  return sentences.map((_, index) => normalizeScan(sentences.slice(index).join(". ")).trim());
});
const CARRIER_HEADER_SET = new Set(CARRIER_HEADERS);
const CARRIER_TARGETS = new Set(
  CARRIER_HEADERS.map((header) => `${header} ${NORMALIZED_RUNTIME_NOTICE}`),
);
const MAX_CARRIER_LENGTH = Math.max(...[...CARRIER_TARGETS].map((target) => target.length));

function delimitedTokenPattern(token: string): RegExp {
  return new RegExp(`(?:^|\\r?\\n)[ \\t]*${escapeRegExp(token)}[ \\t]*(?=\\r?\\n|$)`, "g");
}

const BEGIN_LINE = delimitedTokenPattern(INTERNAL_RUNTIME_CONTEXT_BEGIN);
const END_LINE = delimitedTokenPattern(INTERNAL_RUNTIME_CONTEXT_END);
const CURRENT_HEADER_LINE = delimitedTokenPattern(RUNTIME_CONTEXT_HEADER);
const CURRENT_FOOTER_LINE = delimitedTokenPattern(RUNTIME_CONTEXT_FOOTER);

type WaitingBoundary = "protected" | "current" | "event";

type CarrierProbe = {
  line: string | null;
  lineWhitespace: boolean;
  target: string | null;
  targetWhitespace: boolean;
};

function normalizeScan(text: string): string {
  return text.replace(/\s+/gu, " ").toLowerCase();
}

function buildPrefixFailure(prefix: string): number[] {
  const failure = Array<number>(prefix.length).fill(0);
  for (let index = 1, matched = 0; index < prefix.length; index += 1) {
    while (matched > 0 && prefix[index] !== prefix[matched]) {
      matched = failure[matched - 1] ?? 0;
    }
    if (prefix[index] === prefix[matched]) {
      matched += 1;
    }
    failure[index] = matched;
  }
  return failure;
}

function advanceExactPrefix(
  matched: number,
  text: string,
  prefix: string,
  failure: number[],
): number {
  let current = matched;
  for (const char of text) {
    while (current > 0 && char !== prefix[current]) {
      current = failure[current - 1] ?? 0;
    }
    if (char === prefix[current]) {
      current += 1;
      if (current === prefix.length) {
        return current;
      }
    }
  }
  return current;
}

function primeExactPrefix(text: string, prefix: string): number {
  const maxTail = prefix.length - 1;
  const tail = text.slice(-maxTail);
  for (let length = Math.min(tail.length, maxTail); length > 0; length -= 1) {
    if (prefix.startsWith(tail.slice(-length))) {
      return length;
    }
  }
  return 0;
}

function hasTrigger(lowerText: string): boolean {
  return STREAM_DELIMITERS_LOWER.some((token) => lowerText.includes(token));
}

function createCarrierProbe(): CarrierProbe {
  return { line: "", lineWhitespace: false, target: null, targetWhitespace: false };
}

function canStartCarrierHeader(line: string): boolean {
  return CARRIER_HEADERS.some((header) => header.startsWith(line));
}

function canContinueCarrierTarget(target: string): boolean {
  for (const expected of CARRIER_TARGETS) {
    if (expected.startsWith(target)) {
      return true;
    }
  }
  return false;
}

function advanceCarrierProbe(probe: CarrierProbe, text: string): boolean {
  for (const char of text) {
    if (probe.target !== null) {
      if (/\s/u.test(char)) {
        probe.targetWhitespace = true;
        if (char === "\n" && CARRIER_TARGETS.has(probe.target)) {
          return true;
        }
        continue;
      }
      if (probe.targetWhitespace) {
        probe.target += " ";
      }
      probe.target += char.toLowerCase();
      probe.targetWhitespace = false;
      if (probe.target.length > MAX_CARRIER_LENGTH || !canContinueCarrierTarget(probe.target)) {
        probe.target = null;
      }
      continue;
    }

    if (char === "\r" || char === "\n") {
      if (probe.line !== null && canStartCarrierHeader(probe.line)) {
        probe.lineWhitespace = true;
      } else {
        probe.line = "";
        probe.lineWhitespace = false;
      }
      continue;
    }
    if (probe.line === null) {
      continue;
    }
    if (/\s/u.test(char)) {
      probe.lineWhitespace ||= probe.line.length > 0;
      continue;
    }
    if (probe.lineWhitespace) {
      probe.line += " ";
    }
    probe.line += char.toLowerCase();
    probe.lineWhitespace = false;
    if (CARRIER_HEADER_SET.has(probe.line)) {
      probe.target = probe.line;
      probe.line = null;
    } else if (!canStartCarrierHeader(probe.line)) {
      probe.line = null;
    }
  }
  return probe.target !== null && CARRIER_TARGETS.has(probe.target);
}

function primeCarrierProbe(text: string): CarrierProbe {
  const probe = createCarrierProbe();
  const lineStart = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")) + 1;
  advanceCarrierProbe(probe, text.slice(lineStart));
  return probe;
}

function isPartialDelimiter(line: string): boolean {
  const tail = line.trim();
  return (
    tail.length > 0 &&
    STREAM_DELIMITERS.some(
      (delimiter) => tail.length < delimiter.length && delimiter.startsWith(tail),
    )
  );
}

function lastLine(text: string): string {
  return text.slice(Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")) + 1);
}

function findLastDelimitedTokenIndex(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let index = -1;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    index = match.index;
  }
  return index;
}

function hasOpenProtectedBlock(text: string): boolean {
  BEGIN_LINE.lastIndex = 0;
  END_LINE.lastIndex = 0;
  let depth = 0;
  for (;;) {
    const begin = BEGIN_LINE.exec(text);
    const end = END_LINE.exec(text);
    if (!begin && !end) {
      break;
    }
    if (begin && (!end || begin.index < end.index)) {
      depth += 1;
      END_LINE.lastIndex = begin.index + begin[0].length;
    } else {
      depth = Math.max(0, depth - 1);
      BEGIN_LINE.lastIndex = (end?.index ?? 0) + (end?.[0].length ?? 1);
    }
  }
  return depth > 0;
}

function openBoundary(text: string): WaitingBoundary | null {
  if (hasOpenProtectedBlock(text)) {
    return "protected";
  }
  if (
    findLastDelimitedTokenIndex(text, CURRENT_HEADER_LINE) >
    findLastDelimitedTokenIndex(text, CURRENT_FOOTER_LINE)
  ) {
    return "current";
  }
  const event = text.lastIndexOf(INTERNAL_RUNTIME_CONTEXT_EVENT_PREFIX);
  if (event >= 0 && !text.includes("\n\n", event + INTERNAL_RUNTIME_CONTEXT_EVENT_PREFIX.length)) {
    return "event";
  }
  return null;
}

function boundaryAppeared(boundary: WaitingBoundary, text: string): boolean {
  if (boundary === "protected") {
    return text.includes(INTERNAL_RUNTIME_CONTEXT_END);
  }
  if (boundary === "current") {
    return text.includes(RUNTIME_CONTEXT_FOOTER);
  }
  if (boundary === "event") {
    return /\r?\n[ \t]*\r?\n/u.test(text);
  }
  return false;
}

function safeScanTail(text: string): string {
  const lower = text.toLowerCase();
  let triggerEnd = 0;
  for (const token of STREAM_DELIMITERS_LOWER) {
    const index = lower.lastIndexOf(token);
    if (index >= 0) {
      triggerEnd = Math.max(triggerEnd, index + token.length);
    }
  }
  return text.slice(triggerEnd).slice(-STREAM_SCAN_LENGTH);
}

function atLineStart(text: string): boolean {
  return /^[ \t\r]*$/u.test(lastLine(text));
}

function hasProvisionalProtectedOpening(text: string): boolean {
  return lastLine(text).trim() === INTERNAL_RUNTIME_CONTEXT_BEGIN;
}

function advanceLineStart(lineStart: boolean, appended: string): boolean {
  const lastBreak = Math.max(appended.lastIndexOf("\n"), appended.lastIndexOf("\r"));
  return lastBreak >= 0
    ? /^[ \t\r]*$/u.test(appended.slice(lastBreak + 1))
    : lineStart && /^[ \t\r]*$/u.test(appended);
}

function canonicalOutputReachedSourceTail(source: string, visible: string): boolean {
  const visibleTail = visible.trimEnd().slice(-64);
  return visibleTail.length > 0 && source.trimEnd().endsWith(visibleTail);
}

function withholdIncompleteHeader(text: string, boundary: WaitingBoundary | null): string {
  if (boundary !== "current") {
    return text;
  }
  const lineStart = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")) + 1;
  const tail = normalizeScan(text.slice(lineStart)).trim();
  const incompleteCurrent =
    boundary === "current" &&
    tail.length > 0 &&
    NORMALIZED_CURRENT_HEADER.startsWith(tail) &&
    tail !== NORMALIZED_CURRENT_HEADER;
  if (incompleteCurrent) {
    return text.slice(0, lineStart);
  }
  return text;
}

/** Linear streaming adapter for the canonical runtime-context scrubber. */
export function createRuntimeContextStreamProjector(): TextProjector {
  let sourceLength = 0;
  let published = "";
  let identity = true;
  let prefixOnly = true;
  let waiting: WaitingBoundary | null = null;
  let waitingTail = "";
  let scanTail = "";
  let eventPrefixMatch = 0;
  let withheld = "";
  let lineStart = true;
  let provisionalProtectedOpening = false;
  let awaitingVisibleAfterTransform = false;
  let carrierProbe = createCarrierProbe();

  const result = (
    input: Parameters<TextProjector>[0],
    text: string,
    delta: string | null,
    previousPrefixOnly = prefixOnly,
  ): ReturnType<TextProjector> => {
    const retained = input.retained;
    // Both transports need the same settled boundary. A probe-only stage maps an
    // upstream mutable tail while it emits an unchanged source prefix, and drops
    // the map as soon as a canonical rewrite can change ownership.
    const mapped =
      prefixOnly &&
      previousPrefixOnly &&
      retained &&
      retained.prefix.length <= text.length &&
      (delta !== null || retained.prefix.length <= published.length)
        ? {
            prefix: retained.prefix,
            tail: retained.tail.slice(0, text.length - retained.prefix.length),
          }
        : undefined;
    published = text;
    return mapped
      ? { text, delta, retained: mapped }
      : text === input.text && delta === input.delta
        ? input
        : { text, delta };
  };

  const projectFull = (input: Parameters<TextProjector>[0]): ReturnType<TextProjector> => {
    const previousPrefixOnly = prefixOnly;
    const previous = published;
    let text = stripInternalRuntimeContext(input.text, { streaming: true });
    sourceLength = input.text.length;
    waiting = openBoundary(input.text);
    text = withholdIncompleteHeader(text, waiting);
    prefixOnly = input.text.startsWith(text);
    identity = text === input.text;
    awaitingVisibleAfterTransform =
      !identity && !canonicalOutputReachedSourceTail(input.text, text);
    waitingTail = waiting ? input.text.slice(-STREAM_SCAN_LENGTH) : "";
    scanTail = waiting ? "" : safeScanTail(input.text);
    eventPrefixMatch = primeExactPrefix(input.text, INTERNAL_RUNTIME_CONTEXT_EVENT_PREFIX);
    withheld = "";
    lineStart = atLineStart(text);
    provisionalProtectedOpening =
      waiting === "protected" && hasProvisionalProtectedOpening(input.text);
    carrierProbe = primeCarrierProbe(input.text);
    const delta =
      input.delta === null ? null : text.startsWith(previous) ? text.slice(previous.length) : null;
    return result(input, text, delta, previousPrefixOnly);
  };

  const projector: TextProjector = (input) => {
    const appended = input.delta;
    if (appended === null) {
      return projectFull(input);
    }
    if (appended === "") {
      return identity && input.text === published ? input : result(input, published, "");
    }
    if (input.text.length !== sourceLength + appended.length) {
      return projectFull(input);
    }

    if (waiting) {
      if (provisionalProtectedOpening) {
        const newline = appended.indexOf("\n");
        const beforeNewline = newline < 0 ? appended : appended.slice(0, newline);
        if (/\S/u.test(beforeNewline)) {
          return projectFull(input);
        }
        if (newline >= 0) {
          provisionalProtectedOpening = false;
        }
      }
      const boundaryScan = waitingTail + appended;
      if (!boundaryAppeared(waiting, boundaryScan)) {
        sourceLength = input.text.length;
        waitingTail = boundaryScan.slice(-STREAM_SCAN_LENGTH);
        return result(input, published, "");
      }
      return projectFull(input);
    }

    if (awaitingVisibleAfterTransform) {
      sourceLength = input.text.length;
      if (!/\S/u.test(appended)) {
        return result(input, published, "");
      }
      return projectFull(input);
    }

    if (advanceCarrierProbe(carrierProbe, appended)) {
      return projectFull(input);
    }

    eventPrefixMatch = advanceExactPrefix(
      eventPrefixMatch,
      appended,
      INTERNAL_RUNTIME_CONTEXT_EVENT_PREFIX,
      EVENT_PREFIX_FAILURE,
    );
    if (eventPrefixMatch === INTERNAL_RUNTIME_CONTEXT_EVENT_PREFIX.length) {
      return projectFull(input);
    }

    const scan = normalizeScan(scanTail + appended);
    scanTail = scan.slice(-STREAM_SCAN_LENGTH);
    if (hasTrigger(scan)) {
      return projectFull(input);
    }

    const complete = withheld + appended;
    const newline = Math.max(complete.lastIndexOf("\n"), complete.lastIndexOf("\r"));
    const candidate =
      newline >= 0 ? complete.slice(newline + 1) : withheld || lineStart ? complete : undefined;
    if (candidate !== undefined && isPartialDelimiter(candidate)) {
      // `streaming` treats the whitespace before a tentative delimiter as part
      // of the hidden tail. Derive the withheld bytes from the canonical,
      // non-streaming result so an earlier protected block cannot be restored.
      const safe = stripInternalRuntimeContext(input.text);
      const safeNewline = Math.max(safe.lastIndexOf("\n"), safe.lastIndexOf("\r"));
      const safeCandidate = safe.slice(safeNewline + 1);
      if (!isPartialDelimiter(safeCandidate)) {
        return projectFull(input);
      }
      const visible = safe.slice(0, safe.length - safeCandidate.length).trimEnd();
      const previous = published;
      withheld = safe.slice(visible.length);
      sourceLength = input.text.length;
      published = visible;
      identity = false;
      const delta =
        visible === previous
          ? ""
          : visible.startsWith(previous)
            ? visible.slice(previous.length)
            : null;
      return result(input, visible, delta);
    }

    const resumedWithoutWithholding = withheld !== "";
    withheld = "";
    sourceLength = input.text.length;
    lineStart = advanceLineStart(resumedWithoutWithholding ? true : lineStart, complete);
    if (identity && input.text === published + appended) {
      published = input.text;
      return input;
    }
    published += complete;
    identity &&= published === input.text;
    return result(input, published, complete);
  };
  projector.canReplaceFrom = () => true;
  return projector;
}

export const runtimeContextStreamingTextFilter: TextFilter = {
  transform: (text) => stripInternalRuntimeContext(text, { streaming: true }),
  create: createRuntimeContextStreamProjector,
};

export const runtimeContextFinalTextFilter: TextFilter = {
  activationTokens: [
    INTERNAL_RUNTIME_CONTEXT_BEGIN,
    INTERNAL_RUNTIME_CONTEXT_END,
    RUNTIME_CONTEXT_HEADER,
    "runtime-generated",
  ],
  transform: stripInternalRuntimeContext,
};
