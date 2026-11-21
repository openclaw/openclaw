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

type JsonContainer = {
  opener: JsonOpeningDelimiter;
  start: number;
  end: number;
  children: JsonContainer[];
  eligible: boolean;
  invalid: boolean;
  valid: boolean;
};

type QuoteState = { quoted: boolean; escaped: boolean };

/** Only container-owned strings become invalid at a literal newline; prose keeps its quote. */
function advanceQuotedText(state: QuoteState, char: string | undefined, recover: boolean): boolean {
  if (recover && (char === "\n" || char === "\r")) {
    state.quoted = false;
    state.escaped = false;
    return true;
  }
  if (state.escaped) state.escaped = false;
  else if (char === "\\") state.escaped = true;
  else if (char === '"') state.quoted = false;
  return false;
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
  const roots: JsonContainer[] = [];
  const nodes: JsonContainer[] = [];
  const stack: JsonContainer[] = [];
  const activeOpeners: Record<JsonOpeningDelimiter, number> = { "{": 0, "[": 0 };
  let selectedDepth = 0;
  const quote: QuoteState = { quoted: false, escaped: false };
  let lineStart = true;
  let opaqueIndex = 0;
  let spanEnd = -1;
  let spanOpaque = false;
  const pop = () => {
    const node = stack.pop()!;
    activeOpeners[node.opener] -= 1;
    selectedDepth -= Number(openers.includes(node.opener));
    return node;
  };
  for (let index = 0; index < source.length; index += 1) {
    const atLineStart = lineStart;
    const entering = opaqueSpans[opaqueIndex];
    if (entering?.startIndex === index) {
      // Decide at entry: a span inside a string cannot become framing after
      // that string closes, including in the caller's masked discovery view.
      spanEnd = entering.endIndex;
      spanOpaque = !quote.quoted;
      opaqueIndex++;
    }
    const char = source[index];
    const inSpan = index <= spanEnd;
    const opaque = inSpan && spanOpaque;
    // Discovery selects openers, not record boundaries. Only accepted framing
    // acts as whitespace; original line breaks and indentation own recovery.
    lineStart =
      char === "\n" ||
      (opts.recoverAtLineStart === true && char === "\r") ||
      (lineStart && (opaque || char === " " || char === "\t" || char === "\r"));
    if (opaque) continue;
    const discovery = inSpan ? char : raw[index];
    // Except for declared framing, original text owns structure and strings.
    // Hidden discovery quotes must not turn string interiors into child records.
    if (quote.quoted) {
      const parent = stack.at(-1);
      if (advanceQuotedText(quote, char, !!opts.recoverAtLineStart && parent !== undefined)) {
        parent!.invalid = true;
      }
      continue;
    }
    if (char === '"') {
      quote.quoted = true;
    } else if (char === "{" || char === "[") {
      const selected = discovery === char && openers.includes(char);
      const node: JsonContainer = {
        opener: char,
        start: index,
        end: -1,
        children: [],
        eligible: selected && (selectedDepth === 0 || (!!opts.recoverAtLineStart && atLineStart)),
        invalid: false,
        valid: false,
      };
      const parent = stack.at(-1);
      (parent ? parent.children : roots).push(node);
      nodes.push(node);
      stack.push(node);
      activeOpeners[char] += 1;
      // Discovery controls emission, not ownership by original selected kinds.
      selectedDepth += Number(openers.includes(char));
    } else if (char === "}" || char === "]") {
      const opener = char === "}" ? "{" : "[";
      // A stray closer cannot release its enclosing warning. Counts avoid
      // rescanning that same ancestry for each repeated unmatched closer.
      if (activeOpeners[opener] === 0) {
        const parent = stack.at(-1);
        if (parent) parent.invalid = true;
        continue;
      }
      while (stack.at(-1)!.opener !== opener) {
        pop().invalid = true;
      }
      pop().end = index;
    }
  }
  // Reverse creation order is postorder. Each original own-text interval is
  // parsed at most once; same-kind constants cannot repair adjacent JSON tokens.
  for (const node of nodes.reverse()) {
    if (node.invalid || node.end < 0 || node.children.some((child) => !child.valid)) {
      continue;
    }
    const parts: string[] = [];
    let offset = node.start;
    let quoted = false;
    let escaped = false;
    for (const child of node.children) {
      // Framing can hide a quote during discovery, but a string-interior
      // container is not an original JSON value that we may substitute.
      for (let index = offset; index < child.start; index++) {
        const char = source[index];
        if (escaped) {
          escaped = false;
        } else if (quoted && char === "\\") {
          escaped = true;
        } else if (char === '"') {
          quoted = !quoted;
        }
      }
      if (quoted) {
        node.invalid = true;
        break;
      }
      parts.push(source.slice(offset, child.start), child.opener === "{" ? "{}" : "[]");
      offset = child.end + 1;
    }
    if (node.invalid) continue;
    parts.push(source.slice(offset, node.end + 1));
    try {
      JSON.parse(parts.join(""));
      node.valid = true;
    } catch {
      // A balanced warning is not a record; its eligible children remain usable.
    }
  }
  const fragments: BalancedJsonFragment[] = [];
  const pending = roots.toReversed();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.valid && node.eligible) {
      fragments.push({
        json: source.slice(node.start, node.end + 1),
        startIndex: node.start,
        endIndex: node.end,
      });
    } else {
      for (const child of node.children.toReversed()) {
        pending.push(child);
      }
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

function extractRecoverableJsonAt(
  raw: string,
  opts: BalancedJsonOptions,
  offset: number,
  recovered: JsonSpan[],
  owners: JsonOpeningDelimiter[],
): BalancedJsonFragment | null {
  const openers = opts.openers ?? (["{", "["] as const);
  let start = offset;
  let lineStart = offset === 0 || raw[offset - 1] === "\n" || raw[offset - 1] === "\r";
  const stack: JsonOpeningDelimiter[] = [];
  const recovery: { start: number; lineStart: boolean; recovered: number; epoch: number }[] = [];
  const quote: QuoteState = { quoted: false, escaped: false };
  let epoch = 0;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    const atLineStart = lineStart;
    lineStart =
      char === "\n" ||
      char === "\r" ||
      (lineStart && (char === " " || char === "\t" || char === "\r"));
    if (quote.quoted) {
      if (advanceQuotedText(quote, char, owners.length > 0)) epoch += 1;
      continue;
    }
    // Preserve original ownership through filtered containers and across returned
    // fragments; output selection must not decide whether a quote is prose.
    if (char === "{" || char === "[") owners.push(char);
    else if (char === (owners.at(-1) === "{" ? "}" : "]")) owners.pop();
    if (char === '"') {
      quote.quoted = true;
    } else if (isJsonOpeningDelimiter(char, openers)) {
      if (stack.length === 0) {
        start = index;
      }
      stack.push(char);
      recovery.push({
        start: index,
        lineStart: atLineStart,
        recovered: recovered.length,
        epoch,
      });
    } else if (stack.length > 0 && char === (stack.at(-1) === "{" ? "}" : "]")) {
      stack.pop();
      const closed = recovery.pop();
      if (closed && closed.epoch !== epoch) {
        continue;
      }
      if (stack.length === 0) {
        if (closed) recovered.length = closed.recovered;
        return { json: raw.slice(start, index + 1), startIndex: start, endIndex: index };
      }
      if (closed?.lineStart) {
        // Keep only outermost completed record candidates. A completed root wins;
        // an unmatched warning uses these spans without rescanning its suffix.
        recovered.length = closed.recovered;
        recovered.push({ startIndex: closed.start, endIndex: index });
      }
    }
  }
  return null;
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
  const fragments: BalancedJsonFragment[] = [];
  const owners: JsonOpeningDelimiter[] = [];
  for (let offset = 0; offset < raw.length;) {
    const recovered: JsonSpan[] = [];
    const fragment = opts.recoverAtLineStart
      ? extractRecoverableJsonAt(raw, opts, offset, recovered, owners)
      : extractBalancedJsonAt(raw, opts, offset);
    for (const span of recovered) {
      fragments.push({ ...span, json: raw.slice(span.startIndex, span.endIndex + 1) });
    }
    if (!fragment) break;
    fragments.push(fragment);
    offset = fragment.endIndex + 1;
  }
  return fragments;
}
