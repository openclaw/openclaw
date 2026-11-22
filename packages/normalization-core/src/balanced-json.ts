type JsonOpeningDelimiter = "{" | "[";

type BalancedJsonFragment = {
  json: string;
  startIndex: number;
  endIndex: number;
};
type JsonSpan = Omit<BalancedJsonFragment, "json">;

type BalancedJsonOptions = {
  openers?: readonly JsonOpeningDelimiter[];
  skipQuotedOpeners?: boolean;
};

type BalancedJsonFragmentOptions = BalancedJsonOptions & {
  /** A line-start record can supersede an unmatched opener in preceding prose. */
  recoverAtLineStart?: boolean;
  /** Admit JSON syntax, optionally binding a same-coordinate discovery view to its original text. */
  strictJson?:
    | true
    | {
        source: string;
        /** Ordered, disjoint framing spans; original string ownership takes precedence. */
        opaqueSpans?: readonly JsonSpan[];
      };
};

type StrictJsonOwner = {
  opener: JsonOpeningDelimiter;
  end: number;
  stackIndex: number;
  warning: boolean;
  quote?: QuoteState & { visible: boolean };
};

type QuoteState = { quoted: boolean; escaped: boolean; damaged: boolean };

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
    if (char === "{" || char === "[") return "suspend";
    if ((char === "}" && activeOpeners["{"] > 0) || (char === "]" && activeOpeners["["] > 0))
      return "retire";
  }
  if (recover && (char === "\n" || char === "\r")) {
    const invalidated = !state.damaged;
    state.damaged = true;
    state.escaped = false;
    return invalidated ? "invalidated" : "consumed";
  }
  if (state.escaped) state.escaped = false;
  else if (char === "\\") state.escaped = true;
  else if (char === '"') state.quoted = state.damaged = false;
  return "consumed";
}

function indexOriginalJsonContainers(source: string) {
  const structuralEnds = new Map<number, number>();
  const validEnds = new Map<number, number>();
  const stacks: [OriginalJsonContainer[], OriginalJsonContainer[]] = [[], []];
  const nodes: OriginalJsonContainer[] = [];
  let phase: 0 | 1 = 0;
  let escaped = false;
  // Either quote parity may own a candidate after arbitrary prose. Each opener
  // belongs to one lexical forest, independently of discovery/framing masks.
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"' && !escaped) {
      phase = phase === 0 ? 1 : 0;
    } else if (char === "{" || char === "[") {
      const stack = stacks[phase];
      const node: OriginalJsonContainer = {
        opener: char,
        start: index,
        end: -1,
        children: [],
        valid: false,
      };
      stack.at(-1)?.children.push(node);
      stack.push(node);
      nodes.push(node);
    } else if (char === "}" || char === "]") {
      const stack = stacks[phase];
      if (stack.at(-1)?.opener === (char === "}" ? "{" : "[")) {
        const closed = stack.pop()!;
        closed.end = index;
        structuralEnds.set(closed.start, index);
      } else {
        // A mismatched closer invalidates every enclosing original container;
        // later candidates begin a fresh forest without an ancestry search.
        stack.length = 0;
      }
    }
    escaped = char === "\\" && !escaped;
  }
  // Within each forest, own intervals are disjoint. Across both, reconstruction
  // visits at most twice the source plus two placeholder bytes per child edge.
  for (const node of nodes.reverse()) {
    if (node.end < 0 || node.children.some((child) => !child.valid)) continue;
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
  return { validEnds, structuralEnds };
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
  const { validEnds, structuralEnds } = indexOriginalJsonContainers(source);
  const candidates: (JsonSpan & { visible: boolean })[] = [];
  const candidateClosures = new Map<number, (typeof candidates)[number]>();
  const owners: StrictJsonOwner[] = [];
  const ownerClosures = new Map<number, StrictJsonOwner>();
  const activeOpeners: Record<JsonOpeningDelimiter, number> = { "{": 0, "[": 0 };
  const rootQuote = { quoted: false, escaped: false, damaged: false, visible: false };
  let warningDepth = 0;
  let lineStart = true;
  let opaqueIndex = 0;
  let spanEnd = -1;
  let spanOpaque = false;
  const pop = () => {
    const owner = owners.pop()!;
    activeOpeners[owner.opener] -= 1;
    warningDepth -= Number(owner.warning);
    if (owner.end >= 0) ownerClosures.delete(owner.end);
  };
  for (let index = 0; index < source.length; index += 1) {
    const parent = owners.at(-1);
    const quote = parent ? parent.quote : rootQuote;
    const char = source[index];
    const atLineStart = lineStart;
    const entering = opaqueSpans[opaqueIndex];
    if (entering?.startIndex === index) {
      // Original lexical ownership survives hidden openers and rejected syntax.
      // An inside-string entry is ignored through the entire declared span.
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

    // Candidate completion and source ownership are independent events. Hidden
    // endpoints suppress emission, but still retire the original source owner.
    const candidate = candidateClosures.get(index);
    if (candidate) {
      candidate.visible = !opaque;
      candidateClosures.delete(index);
    }
    const closingOwner = ownerClosures.get(index);
    if (closingOwner && owners[closingOwner.stackIndex] === closingOwner) {
      while (owners.length > closingOwner.stackIndex) pop();
      continue;
    }

    // A quote belongs to its original owner, never an apparent candidate inside
    // it. Hidden quotes still establish lexical ownership; only visible quotes
    // hide candidates. This preserves explicitly exposed string-interior JSON.
    let consumed = false;
    let hidesCandidates = false;
    if (quote?.quoted) {
      hidesCandidates = quote.visible;
      const transition = advanceQuotedText(
        quote,
        char,
        !!opts.recoverAtLineStart && parent !== undefined,
        atLineStart,
        activeOpeners,
      );
      consumed = transition === "consumed" || transition === "invalidated";
      if (!consumed) hidesCandidates = false;
    }
    const discovery = inSpan ? char : raw[index];
    if (
      !opaque &&
      !hidesCandidates &&
      (char === "{" || char === "[") &&
      discovery === char &&
      openers.includes(char) &&
      (warningDepth === 0 || (!!opts.recoverAtLineStart && atLineStart))
    ) {
      const endIndex = validEnds.get(index);
      if (endIndex !== undefined) {
        const record = { startIndex: index, endIndex, visible: false };
        candidates.push(record);
        candidateClosures.set(endIndex, record);
      }
    }
    if (consumed) continue;
    // Complete original containers retain lexical ownership even when framing
    // covers their opener. Unowned external framing must not create a prose quote.
    if (opaque && !parent && !structuralEnds.has(index)) continue;
    if (char === '"') {
      const state = { quoted: true, escaped: false, damaged: false, visible: !opaque };
      if (parent) parent.quote = state;
      else Object.assign(rootQuote, state);
    } else if (char === "{" || char === "[") {
      const end = validEnds.get(index) ?? -1;
      const owner: StrictJsonOwner = {
        opener: char,
        end,
        stackIndex: owners.length,
        // Valid containers are resolved by final emitted containment. Malformed
        // warnings still restrict inline recovery, including filtered kinds.
        warning: end < 0 && openers.includes(char),
      };
      owners.push(owner);
      activeOpeners[char]++;
      warningDepth += Number(owner.warning);
      if (end >= 0) ownerClosures.set(end, owner);
    } else if (char === "}" || char === "]") {
      const opener = char === "}" ? "{" : "[";
      if (activeOpeners[opener] === 0) continue;
      while (owners.at(-1)!.opener !== opener && owners.at(-1)!.end < index) pop();
      if (owners.at(-1)!.end >= index) continue;
      pop();
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
    const frame = stack.pop()!;
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
      if (transition === "invalidated") epoch += 1;
      if (transition === "consumed" || transition === "invalidated") continue;
    }
    if (char === '"') {
      if (parent) parent.quote = { quoted: true, escaped: false, damaged: false };
      else rootQuote.quoted = true;
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
      if (activeOpeners[opener] === 0) continue;
      while (stack.at(-1)!.opener !== opener) {
        // Abandoned selected delimiters invalidate enclosing candidates, but
        // filtered-only retirement preserves delimiter-filtered extraction.
        if (pop().selected) epoch += 1;
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
    ...span,
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
  if (opts.strictJson) return extractStrictJsonFragments(raw, opts);
  if (opts.recoverAtLineStart) return extractRecoverableJsonFragments(raw, opts);
  const fragments: BalancedJsonFragment[] = [];
  for (let offset = 0; offset < raw.length;) {
    const fragment = extractBalancedJsonAt(raw, opts, offset);
    if (!fragment) break;
    fragments.push(fragment);
    offset = fragment.endIndex + 1;
  }
  return fragments;
}
