import { expectDefined } from "./expect.js";

type JsonOpeningDelimiter = "{" | "[";

type BalancedJsonFragment = {
  json: string;
  startIndex: number;
  endIndex: number;
};
type JsonSpan = Omit<BalancedJsonFragment, "json">;

type BalancedJsonOptions = {
  openers?: readonly JsonOpeningDelimiter[];
  /** Ordinary delimiter scans only; strict/recovery scans retain original quote ownership. */
  skipQuotedOpeners?: boolean;
};

type BalancedJsonFragmentOptions = BalancedJsonOptions & {
  /** A line-start record can supersede an unmatched opener in preceding prose. */
  recoverAtLineStart?: boolean;
  /** Outside spans, discovery chooses starts; source owns syntax, quotes and completion.
   * Accepted spans are framing; rejected spans restore source bytes for their full interval.
   * Only accepted framing suppresses an original endpoint. */
  strictJson?:
    | true
    | {
        source: string;
        /** Ordered, disjoint atomic framing spans; an active source string rejects the whole span. */
        opaqueSpans?: readonly JsonSpan[];
      };
};

type StrictJsonOwner = {
  opener: JsonOpeningDelimiter;
  start: number;
  end: number;
  previous?: number;
  next?: number;
  warning: boolean;
  matcherContext: JsonStructureContext;
  quote?: QuoteState;
};

type QuoteState = { quoted: boolean; escaped: boolean; damaged: boolean };
type JsonStructureContext = { phase: 0 | 1; escaped: boolean };

type OriginalJsonContainer = {
  opener: JsonOpeningDelimiter;
  start: number;
  end: number;
  children: OriginalJsonContainer[];
  valid: boolean;
};

type RecoveryFrame = {
  opener: JsonOpeningDelimiter;
  selected: boolean;
  eligible: boolean;
  start: number;
  checkpoint: number;
  epoch: number;
  quote?: QuoteState;
};

/** A newline damages a container string, but its closing quote still owns retirement. */
function advanceQuotedText(
  state: QuoteState,
  char: string | undefined,
  recover: boolean,
  atLineStart: boolean,
  activeOpeners: Readonly<Record<JsonOpeningDelimiter, number>>,
): "consumed" | "invalidated" | "suspend" | "retire" {
  if (state.damaged && atLineStart) {
    // A recovered child suspends its parent's damaged quote. Only retiring
    // that owner or consuming its original closing quote ends its lifetime.
    if (char === "{" || char === "[") {
      return "suspend";
    }
    if ((char === "}" && activeOpeners["{"] > 0) || (char === "]" && activeOpeners["["] > 0)) {
      return "retire";
    }
  }
  if (recover && (char === "\n" || char === "\r")) {
    const invalidated = !state.damaged;
    state.damaged = true;
    state.escaped = false;
    return invalidated ? "invalidated" : "consumed";
  }
  if (state.escaped) {
    state.escaped = false;
  } else if (char === "\\") {
    state.escaped = true;
  } else if (char === '"') {
    state.quoted = state.damaged = false;
  }
  return "consumed";
}

function createJsonStructureMatcher<T extends { opener: JsonOpeningDelimiter; start: number }>(
  create: (opener: JsonOpeningDelimiter, start: number, parent: T | undefined) => T,
) {
  type Entry = { value: T; phase: 0 | 1; previous?: number; next?: number };
  const entries = new Map<number, Entry>();
  const tails: [number | undefined, number | undefined] = [undefined, undefined];
  const groups = new Map<number, number[]>();
  const protectedOwners = new Map<number, number>();
  let phase: 0 | 1 = 0;
  let escaped = false;
  const last = () => entries.get(tails[phase] ?? -1)?.value;
  const remove = (start: number): T | undefined => {
    const entry = entries.get(start);
    if (!entry) {
      return;
    }
    const previous = entries.get(entry.previous ?? -1);
    const next = entries.get(entry.next ?? -1);
    if (previous) {
      previous.next = entry.next;
    }
    if (next) {
      next.previous = entry.previous;
    } else {
      tails[entry.phase] = entry.previous;
    }
    entries.delete(start);
    protectedOwners.delete(start);
    return entry.value;
  };
  const isProtected = (entry: T | undefined, index: number) =>
    (protectedOwners.get(entry?.start ?? -1) ?? -1) >= index;
  // Either quote parity may own a candidate after arbitrary prose. Each opener
  // belongs to one forest. Callers decide which original bytes participate.
  return {
    advance(char: string | undefined, index: number, owner?: number): T | undefined {
      let closed: T | undefined;
      if (char === '"' && !escaped) {
        phase = phase === 0 ? 1 : 0;
      } else if (char === "{" || char === "[") {
        const previous = entries.get(tails[phase] ?? -1);
        const value = create(char, index, previous?.value);
        entries.set(index, { value, phase, previous: tails[phase] });
        if (previous) {
          previous.next = index;
        }
        tails[phase] = index;
        if (owner !== undefined) {
          const group = groups.get(owner) ?? [];
          group.push(index);
          groups.set(owner, group);
        }
      } else if (char === "}" || char === "]") {
        // Exposed string delimiters cannot retire a native-valid owner early.
        if (!isProtected(last(), index)) {
          if (last()?.opener === (char === "}" ? "{" : "[")) {
            closed = remove(expectDefined(tails[phase], "JSON structure tail"));
          } else {
            // Each mismatched forest is discarded once, without an ancestry scan.
            while (last() && !isProtected(last(), index)) {
              remove(expectDefined(tails[phase], "JSON structure tail"));
            }
          }
        }
      }
      escaped = char === "\\" && !escaped;
      return closed;
    },
    checkpoint(): JsonStructureContext {
      return { phase, escaped };
    },
    protect(start: number, end: number) {
      protectedOwners.set(start, end);
    },
    retire(owner: number) {
      // Entries opened inside a lexical owner's quote share its lifetime.
      // Crossing owners have separate groups, even in the other quote forest.
      for (const start of groups.get(owner) ?? []) {
        remove(start);
      }
      groups.delete(owner);
    },
    restore(context: JsonStructureContext) {
      phase = context.phase;
      escaped = context.escaped;
    },
  };
}

function indexOriginalJsonContainers(source: string) {
  const validEnds = new Map<number, number>();
  const nodes: OriginalJsonContainer[] = [];
  const matcher = createJsonStructureMatcher<OriginalJsonContainer>((opener, start, parent) => {
    const node: OriginalJsonContainer = { opener, start, end: -1, children: [], valid: false };
    parent?.children.push(node);
    nodes.push(node);
    return node;
  });
  for (let index = 0; index < source.length; index++) {
    const closed = matcher.advance(source[index], index);
    if (closed) {
      closed.end = index;
    }
  }
  // Within each forest, own intervals are disjoint. Across both, reconstruction
  // visits at most twice the source plus two placeholder bytes per child edge.
  for (const node of nodes.toReversed()) {
    if (node.end < 0 || node.children.some((child) => !child.valid)) {
      continue;
    }
    const parts: string[] = [];
    let offset = node.start;
    for (const child of node.children) {
      parts.push(source.slice(offset, child.start), child.opener === "{" ? "{}" : "[]");
      offset = child.end + 1;
    }
    parts.push(source.slice(offset, node.end + 1));
    try {
      JSON.parse(parts.join(""));
      node.valid = true;
      validEnds.set(node.start, node.end);
    } catch {
      // Original syntax alone owns admission; discovery only chooses candidates.
    }
  }
  return validEnds;
}

function extractStrictJsonFragments(
  raw: string,
  opts: BalancedJsonFragmentOptions,
): BalancedJsonFragment[] {
  const source = typeof opts.strictJson === "object" ? opts.strictJson.source : raw;
  if (source.length !== raw.length) {
    throw new RangeError("JSON discovery and source must have identical UTF-16 coordinates");
  }
  const opaqueSpans =
    typeof opts.strictJson === "object" ? (opts.strictJson.opaqueSpans ?? []) : [];
  let previousEnd = -1;
  for (const span of opaqueSpans) {
    if (
      !Number.isInteger(span.startIndex) ||
      !Number.isInteger(span.endIndex) ||
      span.startIndex <= previousEnd ||
      span.endIndex < span.startIndex ||
      span.endIndex >= source.length
    ) {
      throw new RangeError("Opaque JSON spans must be ordered, disjoint, inclusive source ranges");
    }
    previousEnd = span.endIndex;
  }
  const openers = opts.openers ?? (["{", "["] as const);
  const validEnds = indexOriginalJsonContainers(source);
  const candidates: (JsonSpan & { visible: boolean })[] = [];
  const candidateClosures = new Map<number, (typeof candidates)[number]>();
  const owners = new Map<number, StrictJsonOwner>();
  let tail: number | undefined;
  const ownerClosures = new Map<number, StrictJsonOwner>();
  const warnings = new Map<number, StrictJsonOwner>();
  const warningMatcher = createJsonStructureMatcher((opener, start) => ({ opener, start }));
  const activeOpeners: Record<JsonOpeningDelimiter, number> = { "{": 0, "[": 0 };
  const rootQuote = { quoted: false, escaped: false, damaged: false };
  let warningDepth = 0;
  let lineStart = true;
  let opaqueIndex = 0;
  let spanEnd = -1;
  let spanOpaque = false;
  const retireOwnersFrom = (first: StrictJsonOwner, indexed = false) => {
    let owner: StrictJsonOwner | undefined = first;
    while (owner) {
      const previous = owners.get(owner.previous ?? -1);
      const next = owners.get(owner.next ?? -1);
      if (previous) {
        previous.next = owner.next;
      }
      if (next) {
        next.previous = owner.previous;
      } else {
        tail = owner.previous;
      }
      owners.delete(owner.start);
      warningMatcher.retire(owner.start);
      activeOpeners[owner.opener] -= 1;
      warningDepth -= Number(owner.warning);
      ownerClosures.delete(owner.end);
      warnings.delete(owner.start);
      // An indexed end abandons malformed descendants, not a crossing valid
      // owner. Each removed link is visited once; survivors are never rescanned.
      if (indexed && next && next.end >= 0) {
        return true;
      }
      owner = next;
    }
    warningMatcher.restore(first.matcherContext);
    return false;
  };
  for (let index = 0; index < source.length; index += 1) {
    let parent = owners.get(tail ?? -1);
    let quote = parent ? parent.quote : rootQuote;
    const char = source[index];
    const atLineStart = lineStart;
    const entering = opaqueSpans[opaqueIndex];
    if (entering?.startIndex === index) {
      // Discovery masks do not change source-string ownership. A span entered
      // inside that string is ignored whole; accepted framing creates no state.
      spanEnd = entering.endIndex;
      spanOpaque = !quote?.quoted;
      opaqueIndex++;
    }
    const inSpan = index <= spanEnd;
    const opaque = inSpan && spanOpaque;
    lineStart =
      char === "\n" ||
      (opts.recoverAtLineStart === true && char === "\r") ||
      (lineStart && (opaque || char === " " || char === "\t" || char === "\r"));

    // Outside spans, discovery masks choose starts only. Accepted framing suppresses
    // emission at an endpoint, but still retires its original source owner.
    const candidate = candidateClosures.get(index);
    if (candidate) {
      candidate.visible = !opaque;
      candidateClosures.delete(index);
    }
    const closingOwner = ownerClosures.get(index);
    if (closingOwner) {
      if (!retireOwnersFrom(closingOwner, true)) {
        continue;
      }
      parent = owners.get(tail ?? -1);
      quote = parent ? parent.quote : rootQuote;
    }

    // Framing cannot create quotes, consume warning delimiters, or influence
    // later span entry. Whitespace also breaks a preceding escape's adjacency.
    if (opaque) {
      warningMatcher.advance(" ", index);
      continue;
    }

    // Source quotes retain their owner even when the discovery view masks them.
    // A damaged string suspends only at the existing recovery boundary.
    let consumed = false;
    let hidesCandidates = false;
    if (quote?.quoted) {
      hidesCandidates = true;
      const transition = advanceQuotedText(
        quote,
        char,
        Boolean(opts.recoverAtLineStart) && parent !== undefined,
        atLineStart,
        activeOpeners,
      );
      consumed = transition === "consumed" || transition === "invalidated";
      if (!consumed) {
        hidesCandidates = false;
      }
    }
    if (!consumed && (char === "}" || char === "]")) {
      const opener = char === "}" ? "{" : "[";
      if (activeOpeners[opener] > 0) {
        let survivingOwner = expectDefined(owners.get(tail ?? -1), "surviving JSON owner");
        while (survivingOwner.opener !== opener && survivingOwner.end < index) {
          survivingOwner = expectDefined(
            owners.get(survivingOwner.previous ?? -1),
            "surviving JSON owner",
          );
        }
        if (survivingOwner.end < index) {
          // Consume an actual lexical exit before its token can expire an
          // enclosing warning through a retired child's stale quote phase.
          retireOwnersFrom(survivingOwner);
          continue;
        }
        if (survivingOwner.next !== undefined) {
          retireOwnersFrom(expectDefined(owners.get(survivingOwner.next), "abandoned JSON owner"));
        }
        // A protected survivor still owns this token; its matcher protection
        // handles it below without replaying a delimiter after retirement.
      }
    }
    const matched = warningMatcher.advance(
      char,
      index,
      !consumed && (char === "{" || char === "[") ? index : parent?.start,
    );
    const closingWarning = matched && warnings.get(matched.start);
    if (closingWarning) {
      // Expiry removes only this contribution, not crossing or unfinished
      // lexical owners. Child-consumed bytes still participate in this matcher.
      closingWarning.warning = false;
      warningDepth--;
      warnings.delete(closingWarning.start);
    }
    // Rejected spans restore source bytes atomically, including masked starts
    // after the source quote closes.
    const discovery = inSpan ? char : raw[index];
    if (
      !hidesCandidates &&
      (char === "{" || char === "[") &&
      discovery === char &&
      openers.includes(char) &&
      (warningDepth === 0 || (Boolean(opts.recoverAtLineStart) && atLineStart))
    ) {
      const endIndex = validEnds.get(index);
      if (endIndex !== undefined) {
        const record = { startIndex: index, endIndex, visible: false };
        candidates.push(record);
        candidateClosures.set(endIndex, record);
      }
    }
    if (consumed) {
      continue;
    }
    if (char === '"') {
      const state = { quoted: true, escaped: false, damaged: false };
      if (parent) {
        parent.quote = state;
      } else {
        Object.assign(rootQuote, state);
      }
    } else if (char === "{" || char === "[") {
      const end = validEnds.get(index) ?? -1;
      const owner: StrictJsonOwner = {
        opener: char,
        start: index,
        end,
        previous: tail,
        // Valid containers are resolved by final emitted containment. Malformed
        // warnings still restrict inline recovery, including filtered kinds.
        warning: end < 0 && openers.includes(char),
        matcherContext: warningMatcher.checkpoint(),
      };
      const previous = owners.get(tail ?? -1);
      if (previous) {
        previous.next = index;
      }
      owners.set(index, owner);
      tail = index;
      activeOpeners[char]++;
      warningDepth += Number(owner.warning);
      if (end >= 0) {
        ownerClosures.set(end, owner);
        warningMatcher.protect(index, end);
      }
      if (owner.warning) {
        warnings.set(index, owner);
      }
    }
  }
  const fragments: BalancedJsonFragment[] = [];
  let emittedEnd = -1;
  // Start order is stable. Crossing intervals survive; only a genuinely emitted
  // containing interval suppresses a descendant, regardless of apparent frames.
  for (const candidate of candidates) {
    if (candidate.visible && candidate.endIndex > emittedEnd) {
      fragments.push({
        json: source.slice(candidate.startIndex, candidate.endIndex + 1),
        startIndex: candidate.startIndex,
        endIndex: candidate.endIndex,
      });
      emittedEnd = candidate.endIndex;
    }
  }
  return fragments;
}

function isJsonOpeningDelimiter(
  char: string | undefined,
  openers: readonly JsonOpeningDelimiter[],
): char is JsonOpeningDelimiter {
  return (char === "{" || char === "[") && openers.includes(char);
}

function extractBalancedJsonAt(
  raw: string,
  opts: BalancedJsonOptions,
  offset: number,
): BalancedJsonFragment | null {
  const openers = opts.openers ?? (["{", "["] as const);
  let start = offset;
  if (!opts.skipQuotedOpeners) {
    while (start < raw.length && !isJsonOpeningDelimiter(raw[start], openers)) {
      start += 1;
    }
  }
  const stack: JsonOpeningDelimiter[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (isJsonOpeningDelimiter(char, openers)) {
      if (stack.length === 0) {
        start = index;
      }
      stack.push(char);
    } else if (stack.length > 0 && char === (stack.at(-1) === "{" ? "}" : "]")) {
      stack.pop();
      if (stack.length === 0) {
        return { json: raw.slice(start, index + 1), startIndex: start, endIndex: index };
      }
    }
  }
  return null;
}

function extractRecoverableJsonFragments(
  raw: string,
  opts: BalancedJsonOptions,
): BalancedJsonFragment[] {
  const openers = opts.openers ?? (["{", "["] as const);
  const spans: JsonSpan[] = [];
  const stack: RecoveryFrame[] = [];
  const activeOpeners: Record<JsonOpeningDelimiter, number> = { "{": 0, "[": 0 };
  const rootQuote: QuoteState = { quoted: false, escaped: false, damaged: false };
  let selectedDepth = 0;
  let lineStart = true;
  let epoch = 0;
  const pop = () => {
    const frame = expectDefined(stack.pop(), "JSON recovery frame");
    activeOpeners[frame.opener] -= 1;
    selectedDepth -= Number(frame.selected);
    return frame;
  };
  for (let index = 0; index < raw.length; index += 1) {
    const parent = stack.at(-1);
    const quote = parent ? parent.quote : rootQuote;
    const char = raw[index];
    const atLineStart = lineStart;
    lineStart =
      char === "\n" ||
      char === "\r" ||
      (lineStart && (char === " " || char === "\t" || char === "\r"));
    if (quote?.quoted) {
      const transition = advanceQuotedText(
        quote,
        char,
        stack.length > 0,
        atLineStart,
        activeOpeners,
      );
      if (transition === "invalidated") {
        epoch += 1;
      }
      if (transition === "consumed" || transition === "invalidated") {
        continue;
      }
    }
    if (char === '"') {
      if (parent) {
        parent.quote = { quoted: true, escaped: false, damaged: false };
      } else {
        rootQuote.quoted = true;
      }
    } else if (char === "{" || char === "[") {
      const selected = openers.includes(char);
      // Selection belongs to the original owner, including filtered containers.
      // One pop retires both lifetimes; no stale candidate can claim later text.
      stack.push({
        opener: char,
        selected,
        eligible: selected && (selectedDepth === 0 || atLineStart),
        start: index,
        checkpoint: spans.length,
        epoch,
      });
      activeOpeners[char] += 1;
      selectedDepth += Number(selected);
    } else if (char === "}" || char === "]") {
      const opener = char === "}" ? "{" : "[";
      if (activeOpeners[opener] === 0) {
        continue;
      }
      while (expectDefined(stack.at(-1), "JSON recovery frame").opener !== opener) {
        // Abandoned selected delimiters invalidate enclosing candidates, but
        // filtered-only retirement preserves delimiter-filtered extraction.
        if (pop().selected) {
          epoch += 1;
        }
      }
      const closed = pop();
      if (closed.eligible && closed.epoch === epoch) {
        // Only an emitted ancestor replaces completed children. Keep spans until
        // final selection so nested candidates never copy overlapping source text.
        spans.length = closed.checkpoint;
        spans.push({ startIndex: closed.start, endIndex: index });
      }
    }
  }
  return spans.map((span) => ({
    startIndex: span.startIndex,
    endIndex: span.endIndex,
    json: raw.slice(span.startIndex, span.endIndex + 1),
  }));
}

/** Extracts the first balanced JSON object/array from text. */
export function extractBalancedJsonPrefix(
  raw: string,
  opts: BalancedJsonOptions = {},
): BalancedJsonFragment | null {
  return extractBalancedJsonAt(raw, opts, 0);
}

/** Extracts every balanced JSON object/array fragment; recovery is opt-in here only. */
export function extractBalancedJsonFragments(
  raw: string,
  opts: BalancedJsonFragmentOptions = {},
): BalancedJsonFragment[] {
  if (opts.strictJson) {
    return extractStrictJsonFragments(raw, opts);
  }
  if (opts.recoverAtLineStart) {
    return extractRecoverableJsonFragments(raw, opts);
  }
  const fragments: BalancedJsonFragment[] = [];
  for (let offset = 0; offset < raw.length;) {
    const fragment = extractBalancedJsonAt(raw, opts, offset);
    if (!fragment) {
      break;
    }
    fragments.push(fragment);
    offset = fragment.endIndex + 1;
  }
  return fragments;
}
