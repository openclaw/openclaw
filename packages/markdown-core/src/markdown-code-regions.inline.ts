import { expectDefined } from "@openclaw/normalization-core";
// Range-only CommonMark scanner. HTML is text; GFM tables retain cell ownership.
type InlineSpan = { start: number; end: number };
type InlineFacts = {
  referenceCandidate?: boolean;
  literalReferenceCandidate?: number;
  unresolvedImageCodeStart?: number;
};
const normalizeReference = (value: string): string =>
  value
    .replace(/\0/gu, "\uFFFD")
    .replace(/[\t\n\r ]+/gu, " ")
    .replace(/^ | $/gu, "")
    .toLowerCase()
    .toUpperCase();
const whitespace = (char: string | undefined) => char !== undefined && /[ \t\r\n]/u.test(char);
const punctuation = (char: string | undefined) =>
  char !== undefined && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/u.test(char);
const control = (char: string | undefined) =>
  char === undefined ||
  (char.charCodeAt(0) > 0 && (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));

function labelEnd(text: string, start: number): number | undefined {
  let seen = false;
  let size = 0;
  for (let at = start + 1; at < text.length && size <= 999; at++) {
    const char = text.charAt(at);
    if (char === "]") {
      return seen ? at + 1 : undefined;
    }
    if (char === "[") {
      return undefined;
    }
    if (char === "\r" || char === "\n") {
      continue;
    }
    seen ||= !whitespace(char);
    size++;
    if (char === "\\" && /[[\]\\]/u.test(text[at + 1] ?? "")) {
      at++;
      size++;
    }
  }
  return undefined;
}

function destinationEnd(text: string, start: number, limit: number): number | undefined {
  if (text[start] === "<") {
    for (let at = start + 1; at < text.length; at++) {
      const char = text.charAt(at);
      if (char === ">") {
        return at + 1;
      }
      if (char === "<" || char === "\r" || char === "\n") {
        return undefined;
      }
      if (char === "\\" && /[<>\\]/u.test(text[at + 1] ?? "")) {
        at++;
      }
    }
    return undefined;
  }
  if (text[start] === ")" || whitespace(text[start]) || control(text[start])) {
    return undefined;
  }
  let depth = 0;
  for (let at = start; at <= text.length; at++) {
    const char = text[at];
    if (depth === 0 && (char === undefined || char === ")" || whitespace(char))) {
      return at;
    }
    if (char === "(" && depth < limit) {
      depth++;
    } else if (char === ")") {
      depth--;
    } else if (char === "(" || char === " " || control(char)) {
      return undefined;
    } else if (char === "\\" && /[()\\]/u.test(text[at + 1] ?? "")) {
      at++;
    }
  }
  return undefined;
}

function indexTitles(text: string): Map<number, number> {
  const ends = new Map<number, number>();
  const next = new Map<string, number>();
  for (let at = text.length - 1; at >= 0; at--) {
    const char = text.charAt(at);
    if (char !== "(" && char !== ")" && char !== '"' && char !== "'") {
      continue;
    }
    const end = next.get(char === "(" ? ")" : char);
    if (char !== ")" && end !== undefined) {
      ends.set(at, end);
    }
    let slashes = 0;
    for (let before = at - 1; before >= 0 && text[before] === "\\"; before--) {
      slashes++;
    }
    if (slashes % 2 === 0 && char !== "(") {
      next.set(char, at + 1);
    }
  }
  return ends;
}

function resourceEnd(
  text: string,
  start: number,
  titleEnd: (at: number) => number | undefined,
): number | undefined {
  let at = start + 1;
  while (whitespace(text[at])) {
    at++;
  }
  if (text[at] === ")") {
    return at + 1;
  }
  const destination = destinationEnd(text, at, 32);
  if (destination === undefined) {
    return undefined;
  }
  at = destination;
  while (whitespace(text[at])) {
    at++;
  }
  if (at > destination && /["'(]/u.test(text[at] ?? "")) {
    const title = titleEnd(at);
    if (title === undefined) {
      return undefined;
    }
    at = title;
    while (whitespace(text[at])) {
      at++;
    }
  }
  return text[at] === ")" ? at + 1 : undefined;
}

export function parseReferenceDefinitions(text: string): {
  end: number;
  definitions: Array<{ name: string; start: number; end: number }>;
} {
  const definitions: Array<{ name: string; start: number; end: number }> = [];
  let end = 0;
  let titles: Map<number, number> | undefined;
  const lineEnd = (start: number) => {
    let at = start;
    while (text[at] === " " || text[at] === "\t") {
      at++;
    }
    if (at === text.length) {
      return at;
    }
    if (text[at] === "\r") {
      return at + (text[at + 1] === "\n" ? 2 : 1);
    }
    return text[at] === "\n" ? at + 1 : undefined;
  };
  while (end < text.length) {
    let at = end;
    while (text[at] === " " || text[at] === "\t") {
      at++;
    }
    if (text[at] !== "[") {
      break;
    }
    const start = at;
    const label = labelEnd(text, at);
    if (label === undefined || text[label] !== ":") {
      break;
    }
    const name = normalizeReference(text.slice(at + 1, label - 1));
    at = label + 1;
    while (whitespace(text[at])) {
      at++;
    }
    const destination = destinationEnd(text, at, Infinity);
    if (destination === undefined) {
      break;
    }
    at = destination;
    while (whitespace(text[at])) {
      at++;
    }
    const title =
      at > destination && /["'(]/u.test(text[at] ?? "")
        ? (titles ??= indexTitles(text)).get(at)
        : undefined;
    const after = title !== undefined ? lineEnd(title) : undefined;
    const next = after ?? lineEnd(destination);
    if (next === undefined) {
      break;
    }
    let contentEnd = next;
    if (text[contentEnd - 1] === "\n") {
      contentEnd--;
    }
    if (text[contentEnd - 1] === "\r") {
      contentEnd--;
    }
    definitions.push({ name, start, end: contentEnd });
    end = next;
  }
  return { end, definitions };
}

export function scanInlineCode(
  text: string,
  defined: Set<string>,
  maxName: number,
  facts?: InlineFacts,
): InlineSpan[] {
  let titles: Map<number, number> | undefined;
  const titleEnd = (at: number) => (titles ??= indexTitles(text)).get(at);
  const runs = [...text.matchAll(/`+/gu)];
  const next = new Map<number, number>();
  const close = new Map<number, number>();
  for (let n = runs.length - 1; n >= 0; n--) {
    const run = expectDefined(runs[n], "Markdown scan position");
    let slashes = 0;
    for (let at = run.index - 1; at >= 0 && text[at] === "\\"; at--) {
      slashes++;
    }
    const escaped = slashes % 2;
    const end = next.get(run[0].length - escaped);
    if (end !== undefined) {
      close.set(run.index + escaped, end);
    }
    next.set(run[0].length, run.index + run[0].length);
  }
  const regions: InlineSpan[] = [];
  const brackets: Array<{ alive: boolean; at?: number }> | undefined = facts ? [] : undefined;
  const unresolved: InlineSpan[] = [];
  const starts: Array<{
    at: number;
    image: boolean;
    active: boolean;
    region: number;
    bracketCount: number;
    literal?: { alive: boolean };
  }> = [];
  const activeLinks: typeof starts = [];
  const whitespaceEnds = new Map<number, number>();
  if (defined.size) {
    for (const run of text.matchAll(/[ \t\r\n]+/gu)) {
      whitespaceEnds.set(run.index, run.index + run[0].length);
    }
  }
  const isDefined = (start: number, end: number) => {
    if (!defined.size) {
      return false;
    }
    let name = "";
    for (let at = start; at < end;) {
      const after = whitespaceEnds.get(at);
      if (after !== undefined) {
        if (name && after < end) {
          name += " ";
        }
        at = after;
      } else {
        name += text[at++];
      }
      if (name.length > maxName) {
        return false;
      }
    }
    return defined.has(name.replace(/\0/gu, "\uFFFD").toLowerCase().toUpperCase());
  };
  for (let at = 0; at < text.length;) {
    const char = text.charAt(at);
    if (char === "\\" && punctuation(text[at + 1])) {
      if (text[at + 1] === "[") {
        brackets?.push({ alive: true, at: at + 1 });
      }
      at += 2;
      continue;
    }
    if (
      brackets &&
      char === "&" &&
      /^&(?:#0{0,5}91|#[xX]0{0,4}5[bB]|lbrack|lsqb);/u.test(text.slice(at, at + 40))
    ) {
      brackets.push({ alive: true });
    }
    if (char === "`") {
      const end = close.get(at);
      if (end !== undefined) {
        regions.push({ start: at, end });
        at = end;
      } else {
        do {
          at++;
        } while (text[at] === "`");
      }
      continue;
    }
    if (char === "<") {
      let end = at + 1;
      while (
        end < text.length &&
        text.charAt(end) !== "<" &&
        text.charAt(end) !== ">" &&
        (text.charCodeAt(end) === 0 || (text.charCodeAt(end) > 32 && text.charCodeAt(end) !== 127))
      ) {
        end++;
      }
      if (text[end] === ">") {
        const body = text.slice(at + 1, end);
        if (
          /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/u.test(body) ||
          /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/u.test(
            body,
          )
        ) {
          const bracket = body.lastIndexOf("[");
          if (bracket >= 0) {
            brackets?.push({ alive: true, at: at + 1 + bracket });
          }
          at = end + 1;
          continue;
        }
      }
    }
    if (char === "[" || (char === "!" && text[at + 1] === "[")) {
      const literal = brackets ? { alive: true, at: char === "!" ? at + 1 : at } : undefined;
      const opener = {
        at: char === "!" ? at + 1 : at,
        image: char === "!",
        active: true,
        region: regions.length,
        bracketCount: brackets?.length ?? 0,
        literal,
      };
      if (literal) {
        brackets?.push(literal);
      }
      starts.push(opener);
      if (!opener.image) {
        activeLinks.push(opener);
      }
      at = opener.at + 1;
      continue;
    }
    if (char === "]" && starts.length) {
      const opener = expectDefined(starts.pop(), "Markdown scan position");
      if (opener.active) {
        let end: number | undefined;
        if (text[at + 1] === "(") {
          end = resourceEnd(text, at + 1, titleEnd);
        }
        if (text[at + 1] === "[") {
          const label = labelEnd(text, at + 1);
          if (
            label !== undefined &&
            defined.has(normalizeReference(text.slice(at + 2, label - 1)))
          ) {
            end = label;
          } else if (text[at + 2] === "]" && isDefined(opener.at + 1, at)) {
            end = at + 3;
          }
        } else if (end === undefined && isDefined(opener.at + 1, at)) {
          end = at + 1;
        }
        if (end !== undefined) {
          if (opener.image) {
            regions.length = opener.region;
            if (brackets) {
              brackets.length = opener.bracketCount;
            }
          } else {
            if (opener.literal) {
              opener.literal.alive = false;
            }
            for (const link of activeLinks) {
              link.active = false;
            }
            activeLinks.length = 0;
          }
          at = end;
          continue;
        }
      }
      if (facts && opener.image && regions[opener.region]) {
        unresolved.push(expectDefined(regions[opener.region], "Markdown scan position"));
      }
    }
    at++;
  }
  if (facts) {
    for (const opener of starts) {
      if (opener.image && regions[opener.region]) {
        unresolved.push(expectDefined(regions[opener.region], "Markdown scan position"));
      }
    }
    facts.referenceCandidate = brackets?.some((bracket) => bracket.alive);
    facts.literalReferenceCandidate = brackets?.findLast(
      (bracket) => bracket.alive && bracket.at !== undefined,
    )?.at;
    const live = new Set(regions);
    for (const region of unresolved) {
      if (
        live.has(region) &&
        (facts.unresolvedImageCodeStart === undefined ||
          region.start < facts.unresolvedImageCodeStart)
      ) {
        facts.unresolvedImageCodeStart = region.start;
      }
    }
  }
  return regions;
}
