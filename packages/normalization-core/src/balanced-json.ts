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
  /** A line-start record can supersede an unmatched opener in preceding prose. */
  recoverAtLineStart?: boolean;
  /** Admit JSON syntax, optionally binding a same-coordinate discovery view to its original text. */
  strictJson?: true | { source: string };
};

type JsonContainer = {
  opener: JsonOpeningDelimiter;
  start: number;
  end: number;
  children: JsonContainer[];
  selected: boolean;
  eligible: boolean;
  invalid: boolean;
  valid: boolean;
};

function extractStrictJsonFragments(
  raw: string,
  opts: BalancedJsonOptions,
): BalancedJsonFragment[] {
  const source = typeof opts.strictJson === "object" ? opts.strictJson.source : raw;
  if (source.length !== raw.length) {
    throw new RangeError("JSON discovery and source must have identical UTF-16 coordinates");
  }
  const openers = opts.openers ?? (["{", "["] as const);
  const roots: JsonContainer[] = [];
  const nodes: JsonContainer[] = [];
  const stack: JsonContainer[] = [];
  let selectedDepth = 0;
  let inString = false;
  let escaped = false;
  let lineStart = true;
  const pop = () => {
    const node = stack.pop()!;
    selectedDepth -= Number(node.selected);
    return node;
  };
  for (let index = 0; index < source.length; index += 1) {
    const atLineStart = lineStart;
    const discovery = raw[index];
    lineStart =
      discovery === "\n" ||
      (opts.recoverAtLineStart === true && discovery === "\r") ||
      (lineStart && (discovery === " " || discovery === "\t" || discovery === "\r"));
    // Discovery selects eligible openings, never structure or string ownership.
    // Otherwise hidden quotes could turn a string interior into a child record.
    const char = source[index];
    if (inString) {
      if (opts.recoverAtLineStart && (char === "\n" || char === "\r")) {
        const parent = stack.at(-1);
        if (parent) {
          parent.invalid = true;
        }
        inString = false;
        escaped = false;
      } else if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      const selected = discovery === char && openers.includes(char);
      const node: JsonContainer = {
        opener: char,
        start: index,
        end: -1,
        children: [],
        selected,
        eligible: selected && (selectedDepth === 0 || (!!opts.recoverAtLineStart && atLineStart)),
        invalid: false,
        valid: false,
      };
      const parent = stack.at(-1);
      (parent ? parent.children : roots).push(node);
      nodes.push(node);
      stack.push(node);
      selectedDepth += Number(selected);
    } else if (char === "}" || char === "]") {
      const opener = char === "}" ? "{" : "[";
      while (stack.length > 0 && stack.at(-1)!.opener !== opener) {
        pop().invalid = true;
      }
      if (stack.length > 0) {
        pop().end = index;
      }
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
    for (const child of node.children) {
      parts.push(source.slice(offset, child.start), child.opener === "{" ? "{}" : "[]");
      offset = child.end + 1;
    }
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
  recovered: JsonSpan[] = [],
): BalancedJsonFragment | null {
  const openers = opts.openers ?? (["{", "["] as const);
  let start = offset;
  let lineStart =
    offset === 0 ||
    raw[offset - 1] === "\n" ||
    (opts.recoverAtLineStart === true && raw[offset - 1] === "\r");
  if (!opts.skipQuotedOpeners && !opts.recoverAtLineStart) {
    while (start < raw.length && !isJsonOpeningDelimiter(raw[start], openers)) {
      const char = raw[start];
      lineStart = char === "\n" || (lineStart && (char === " " || char === "\t" || char === "\r"));
      start += 1;
    }
  }
  const stack: {
    opener: JsonOpeningDelimiter;
    start: number;
    lineStart: boolean;
    recovered: number;
    epoch: number;
  }[] = [];
  let inString = false;
  let escaped = false;
  let epoch = 0;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    const atLineStart = lineStart;
    lineStart =
      char === "\n" ||
      (opts.recoverAtLineStart === true && char === "\r") ||
      (lineStart && (char === " " || char === "\t" || char === "\r"));
    if (inString) {
      if (opts.recoverAtLineStart && (char === "\n" || char === "\r")) {
        // Literal line breaks cannot belong to a JSON string. Keep completed
        // child candidates, but never let this invalid parent supersede them.
        inString = false;
        escaped = false;
        epoch += 1;
      } else if (escaped) {
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
      stack.push({
        opener: char,
        start: index,
        lineStart: atLineStart,
        recovered: recovered.length,
        epoch,
      });
    } else if (stack.length > 0 && char === (stack.at(-1)?.opener === "{" ? "}" : "]")) {
      const closed = stack.pop();
      if (!closed) {
        continue;
      }
      if (closed.epoch !== epoch) {
        continue;
      }
      if (stack.length === 0) {
        recovered.length = closed.recovered;
        return { json: raw.slice(start, index + 1), startIndex: start, endIndex: index };
      }
      if (opts.recoverAtLineStart && closed.lineStart) {
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
  if (opts.strictJson) {
    return extractStrictJsonFragments(raw, opts)[0] ?? null;
  }
  const recovered: JsonSpan[] = [];
  const root = extractBalancedJsonAt(raw, opts, 0, recovered);
  const first = recovered[0];
  return first ? { ...first, json: raw.slice(first.startIndex, first.endIndex + 1) } : root;
}

/** Extracts every balanced JSON object/array fragment from arbitrary text. */
export function extractBalancedJsonFragments(
  raw: string,
  opts: BalancedJsonOptions = {},
): BalancedJsonFragment[] {
  if (opts.strictJson) {
    return extractStrictJsonFragments(raw, opts);
  }
  const fragments: BalancedJsonFragment[] = [];
  for (let offset = 0; offset < raw.length;) {
    const recovered: JsonSpan[] = [];
    const fragment = extractBalancedJsonAt(raw, opts, offset, recovered);
    for (const span of recovered) {
      fragments.push({ ...span, json: raw.slice(span.startIndex, span.endIndex + 1) });
    }
    if (!fragment) {
      break;
    }
    fragments.push(fragment);
    offset = fragment.endIndex + 1;
  }
  return fragments;
}
