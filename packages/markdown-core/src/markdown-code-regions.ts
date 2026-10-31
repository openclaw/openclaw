import { expectDefined } from "@openclaw/normalization-core";
import { scanInlineCode, parseReferenceDefinitions } from "./markdown-code-regions.inline.js";
import {
  collectMarkdownOwnership,
  type MarkdownCodeRegion,
  type Root,
  type MarkdownCodeOwnership,
} from "./markdown-code-regions.ownership.js";
export type { MarkdownCodeRegion } from "./markdown-code-regions.ownership.js";
type Region = MarkdownCodeRegion;
type Line = {
  body: string;
  start: number;
  end: number;
  next: number;
  map?: number[];
  theme?: { start: number; third: number };
};
type Part = { line: Line; from: number; to: number; lazy?: boolean; tableEligible?: boolean };
type Block = { parts: Part[]; kind: "paragraph" | "inline" } | Region;
type Container = { kind: "quote" | "list"; indent: number; total: number; root?: Root };
function sourceOffset(line: Line, at: number) {
  return line.map?.[at] ?? line.start + at;
}
function lineAt(text: string, start: number): Line {
  let end = start;
  while (end < text.length && text[end] !== "\r" && text[end] !== "\n") {
    end++;
  }
  const next = end + (text[end] === "\r" && text[end + 1] === "\n" ? 2 : end < text.length ? 1 : 0);
  let body = text.slice(start, end);
  let map: number[] | undefined;
  if (body.includes("\t")) {
    const chars: string[] = [];
    map = [];
    for (let n = start; n < end; n++) {
      const count = text[n] === "\t" ? 4 - (chars.length % 4) : 1;
      for (let k = 0; k < count; k++) {
        chars.push(text[n] === "\t" ? " " : text.charAt(n));
        map.push(n + (k ? 1 : 0));
      }
    }
    body = chars.join("");
    map.push(end);
  }
  let tail = body.length - 1;
  while (body[tail] === " ") {
    tail--;
  }
  const marker = body[tail];
  let theme: Line["theme"];
  if (marker === "-" || marker === "_" || marker === "*") {
    let count = 0,
      third = -1;
    while (tail >= 0 && (body[tail] === marker || body[tail] === " ")) {
      if (body[tail] === marker && ++count === 3) {
        third = tail;
      }
      tail--;
    }
    if (third >= 0) {
      theme = { start: tail + 1, third };
    }
  }
  return { body, start, end, next, map, theme };
}
const spaces = (text: string, at: number) => {
  let end = at;
  while (text[end] === " ") {
    end++;
  }
  return end - at;
};
function fenceAt(text: string, at: number) {
  const prefix = spaces(text, at);
  if (prefix > 3) {
    return undefined;
  }
  const start = at + prefix;
  const char = text[start];
  if (char !== "`" && char !== "~") {
    return undefined;
  }
  let end = start;
  while (text[end] === char) {
    end++;
  }
  if (end - start < 3 || (char === "`" && text.slice(end).includes("`"))) {
    return undefined;
  }
  return { start, end, char, size: end - start };
}
function thematic(line: Line, at: number) {
  const indent = spaces(line.body, at);
  return Boolean(
    line.theme && indent < 4 && at + indent >= line.theme.start && at + indent <= line.theme.third,
  );
}
function listAt(line: Line, at: number, interrupt: boolean) {
  const text = line.body;
  const prefix = spaces(text, at);
  if (prefix > 3) {
    return undefined;
  }
  const match = /^(?:([-+*])|(\d{1,9})([.)]))( +|$)/u.exec(text.slice(at + prefix));
  if (!match || thematic(line, at)) {
    return undefined;
  }
  const marker = match[1]?.length ?? expectDefined(match[2], "Markdown scan position").length + 1;
  const after = at + prefix + marker;
  const padding = spaces(text, after);
  const content =
    after + (after + padding === text.length || padding > 4 ? 1 : Math.max(1, padding));
  if (
    interrupt &&
    ((match[2] !== undefined && match[2] !== "1") || after + padding === text.length)
  ) {
    return undefined;
  }
  return { content, indent: content - at, empty: after + padding === text.length };
}
function interrupts(line: Line, at: number) {
  const text = line.body;
  const start = at + spaces(text, at);
  return (
    start - at < 4 &&
    (text[start] === ">" ||
      /^#{1,6}(?: |$)/u.test(text.slice(start)) ||
      thematic(line, at) ||
      Boolean(fenceAt(text, at)) ||
      Boolean(listAt(line, at, true)))
  );
}
function cells(line: Line, from: number): Part[] {
  const parts: Part[] = [];
  let start = from;
  let slashes = 0;
  for (let n = from; n < line.body.length; n++) {
    const char = line.body[n];
    if (char === "|" && slashes % 2 === 0) {
      parts.push({ line, from: start, to: n });
      start = n + 1;
    }
    slashes = char === "\\" ? slashes + 1 : 0;
  }
  parts.push({ line, from: start, to: line.body.length });
  if (
    parts.length > 1 &&
    /^ *$/u.test(
      line.body.slice(
        expectDefined(parts[0], "Markdown scan position").from,
        expectDefined(parts[0], "Markdown scan position").to,
      ),
    )
  ) {
    parts.shift();
  }
  if (
    parts.length > 1 &&
    /^ *$/u.test(
      line.body.slice(
        expectDefined(parts.at(-1), "Markdown scan position").from,
        expectDefined(parts.at(-1), "Markdown scan position").to,
      ),
    )
  ) {
    parts.pop();
  }
  return parts;
}
function joined(parts: Part[]) {
  return parts.map((part) => part.line.body.slice(part.from, part.to)).join("\n");
}
function translated(parts: Part[], spans: Array<{ start: number; end: number }>): Region[] {
  let index = 0,
    base = 0;
  const point = (position: number) => {
    while (
      index + 1 < parts.length &&
      position >
        base +
          expectDefined(parts[index], "Markdown scan position").to -
          expectDefined(parts[index], "Markdown scan position").from
    ) {
      base +=
        expectDefined(parts[index], "Markdown scan position").to -
        expectDefined(parts[index], "Markdown scan position").from +
        1;
      index++;
    }
    const part = expectDefined(parts[index], "Markdown scan position");
    return sourceOffset(part.line, part.from + position - base);
  };
  return spans.map((span) => ({ start: point(span.start), end: point(span.end), block: false }));
}
type ScanOptions = { syntax?: "commonmark" | "gfm" };
function scanMarkdown(
  text: string,
  options: ScanOptions | undefined,
  ownership: true,
): MarkdownCodeOwnership;
function scanMarkdown(text: string, options: ScanOptions | undefined, ownership: false): Region[];
function scanMarkdown(
  rawText: string,
  options: ScanOptions | undefined,
  ownership: boolean,
): MarkdownCodeOwnership | Region[] {
  // Micromark drops an initial BOM before positions, but retention uses the original input.
  const text = rawText.startsWith("\uFEFF") ? rawText.slice(1) : rawText;
  const roots: Root[] | undefined = ownership ? [] : undefined;
  const owners = ownership ? new Map<Block, Root>() : undefined;
  let activeRoot: Root | undefined;
  const rootFor = (start: number, kind: string) => {
    if (!ownership) {
      return undefined;
    }
    if (containers.length) {
      return expectDefined(containers[0], "Markdown scan position").root;
    }
    if (!activeRoot) {
      activeRoot = { start, end: start, kind, parts: 0 };
      roots?.push(activeRoot);
    }
    return activeRoot;
  };
  const emit = (block: Block) => {
    blocks.push(block);
    if (activeRoot) {
      owners?.set(block, activeRoot);
      activeRoot.parts++;
    }
  };
  const blocks: Block[] = [];
  const containers: Container[] = [];
  let firstQuote = -1,
    firstEmpty = -1;
  let pendingEmptyLazy = false;
  let paragraph: Part[] = [];
  let table = false;
  let fence: { start: number; end: number; last: number; char: string; size: number } | undefined;
  let indented: (Region & { lazy?: boolean }) | undefined;
  const flush = () => {
    if (paragraph.length) {
      if (activeRoot && !containers.length) {
        activeRoot.end = expectDefined(paragraph.at(-1), "Markdown scan position").line.end;
      }
      emit({ kind: "paragraph", parts: paragraph });
      paragraph = [];
      if (!containers.length) {
        activeRoot = undefined;
      }
    }
    table = false;
  };
  const endCode = () => {
    if (fence) {
      emit({ start: fence.start, end: fence.end, block: true });
      fence = undefined;
    }
    if (indented) {
      emit({ start: indented.start, end: indented.end, block: true });
      indented = undefined;
    }
  };
  for (let raw = 0; raw < text.length;) {
    const line = lineAt(text, raw);
    raw = line.next;
    const body = line.body;
    let spaceStart = -1,
      spaceEnd = -1;
    // Nested list continuations share one indentation run; do not scan its suffix per level.
    const indentation = (at: number) => {
      if (at < spaceStart || at > spaceEnd) {
        spaceStart = at;
        spaceEnd = at + spaces(body, at);
      }
      return spaceEnd - at;
    };
    const emptyLazy = pendingEmptyLazy;
    if (indentation(0) < body.length) {
      pendingEmptyLazy = false;
    }
    if (indented?.lazy) {
      endCode();
      if (!containers.length) {
        activeRoot = undefined;
      }
    }
    let at = 0,
      matched = 0;
    if (indentation(0) === body.length) {
      matched = Math.min(
        firstQuote < 0 ? containers.length : firstQuote,
        firstEmpty < 0 ? containers.length : firstEmpty,
      );
      at = Math.min(body.length, containers[matched - 1]?.total ?? 0);
    } else {
      for (const container of containers) {
        const indent = indentation(at);
        if (firstEmpty === matched && at + indent === body.length) {
          break;
        }
        if (container.kind === "quote") {
          if (indent < 4 && body[at + indent] === ">") {
            at += indent + 1;
            if (body[at] === " ") {
              at++;
            }
          } else {
            break;
          }
        } else if (indent >= container.indent) {
          at += container.indent;
        } else if (at + indent === body.length) {
          at = body.length;
        } else {
          break;
        }
        if (firstEmpty === matched) {
          firstEmpty = -1;
        }
        matched++;
      }
    }
    const newContainerInterrupt =
      matched === containers.length && (paragraph.length > 0 || Boolean(indented));
    const missing = matched < containers.length;
    const newContainer =
      indentation(at) < 4 &&
      (body[at + indentation(at)] === ">" || Boolean(listAt(line, at, false)));
    const lazy =
      matched < containers.length &&
      !newContainer &&
      paragraph.length > 0 &&
      at + indentation(at) < body.length &&
      !interrupts(line, at);
    if (matched < containers.length && !lazy) {
      if (firstEmpty === matched && indentation(at) === body.length - at) {
        pendingEmptyLazy = true;
      }
      if (fence && !newContainer) {
        fence.end = fence.last;
      }
      endCode();
      flush();
      containers.length = matched;
      activeRoot = containers[0]?.root;
      if (firstQuote >= matched) {
        firstQuote = -1;
      }
      if (firstEmpty >= matched) {
        firstEmpty = -1;
      }
    }
    if (!fence && !lazy) {
      while (true) {
        const indent = indentation(at);
        if (indent < 4 && body[at + indent] === ">") {
          endCode();
          flush();
          const markerStart = sourceOffset(line, at + indent);
          at += indent + 1;
          if (body[at] === " ") {
            at++;
          }
          if (!containers.length) {
            activeRoot = undefined;
          }
          const root = rootFor(markerStart, "quote");
          if (firstQuote < 0) {
            firstQuote = containers.length;
          }
          containers.push({ kind: "quote", indent: 0, total: containers.at(-1)?.total ?? 0, root });
          continue;
        }
        const list = listAt(line, at, newContainerInterrupt);
        if (list) {
          endCode();
          flush();
          if (!containers.length) {
            activeRoot = undefined;
          }
          const root = rootFor(sourceOffset(line, at + indent), "list");
          if (list.empty) {
            firstEmpty = containers.length;
          }
          containers.push({
            kind: "list",
            indent: list.indent,
            total: (containers.at(-1)?.total ?? 0) + list.indent,
            root,
          });
          at = Math.min(list.content, body.length);
          continue;
        }
        break;
      }
    }
    if (containers.length) {
      activeRoot = expectDefined(containers[0], "Markdown scan position").root;
    }
    if (fence) {
      if (activeRoot) {
        activeRoot.end = line.end;
      }
      const close = fenceAt(body, at);
      if (
        close &&
        close.char === fence.char &&
        close.size >= fence.size &&
        /^ *$/u.test(body.slice(close.end))
      ) {
        fence.end = line.end;
        endCode();
        if (!containers.length) {
          activeRoot = undefined;
        }
      } else {
        fence.last = at === body.length && line.next === line.end ? line.start : line.end;
        fence.end = line.next > line.end ? line.next : fence.last;
      }
      continue;
    }
    const indent = indentation(at);
    const blank = at + indent === body.length;
    if (indented) {
      if (indent >= 4) {
        if (activeRoot) {
          activeRoot.end = line.end;
        }
        indented.end = line.end;
        continue;
      }
      if (blank) {
        continue;
      }
      endCode();
      if (!containers.length) {
        activeRoot = undefined;
      }
    }
    if (blank) {
      flush();
      if (!containers.length) {
        activeRoot = undefined;
      }
      continue;
    }
    activeRoot = rootFor(
      sourceOffset(line, indent >= 4 ? at : at + indent),
      paragraph.length ? "paragraph" : indent >= 4 ? "indented" : "paragraph",
    );
    if (activeRoot) {
      activeRoot.end = line.end;
      activeRoot.firstContent ??= sourceOffset(line, at + indent);
    }
    const marker = fenceAt(body, at);
    if (marker) {
      flush();
      if (!containers.length) {
        activeRoot = undefined;
        activeRoot = rootFor(sourceOffset(line, marker.start), "fence");
        if (activeRoot) {
          activeRoot.end = line.end;
        }
      }
      fence = {
        start: sourceOffset(line, marker.start),
        end: line.next,
        last: line.end,
        char: marker.char,
        size: marker.size,
      };
      continue;
    }
    if (!paragraph.length && indent >= 4) {
      table = false;
      indented = {
        start: sourceOffset(line, at),
        end: line.end,
        block: true,
        ...((missing && !newContainer) || emptyLazy ? { lazy: true } : {}),
      };
      continue;
    }
    const visible = at + indent;
    const tail = body.slice(visible);
    if (indent < 4 && /^#{1,6}(?: |$)/u.test(tail)) {
      flush();
      if (!containers.length) {
        activeRoot = undefined;
        activeRoot = rootFor(sourceOffset(line, visible), "heading");
        if (activeRoot) {
          activeRoot.end = line.end;
        }
      }
      emit({ kind: "inline", parts: [{ line, from: visible, to: body.length }] });
      if (!containers.length) {
        activeRoot = undefined;
      }
      continue;
    }
    if (paragraph.length && indent < 4) {
      const previous = expectDefined(paragraph.at(-1), "Markdown scan position");
      const header = cells(previous.line, previous.from);
      const delimiter = cells(line, at);
      if (
        options?.syntax !== "commonmark" &&
        !lazy &&
        previous.tableEligible &&
        header.length === delimiter.length &&
        (body.slice(at).includes(":") || body.slice(at).includes("|")) &&
        delimiter.every((part) => /^ *:?-+:? *$/u.test(body.slice(part.from, part.to)))
      ) {
        paragraph.pop();
        flush();
        if (!containers.length) {
          activeRoot = undefined;
          activeRoot = rootFor(sourceOffset(previous.line, previous.from), "table");
          if (activeRoot) {
            activeRoot.end = line.end;
          }
        }
        for (const cell of header) {
          emit({ kind: "inline", parts: [cell] });
        }
        table = true;
        continue;
      }
      if (
        !lazy &&
        /^(?:=+|-+) *$/u.test(tail) &&
        (() => {
          const value = joined(paragraph);
          return parseReferenceDefinitions(value).end < value.length;
        })()
      ) {
        emit({ kind: "paragraph", parts: paragraph });
        paragraph = [];
        table = false;
        if (!containers.length) {
          if (activeRoot) {
            activeRoot.kind = "heading";
          }
          activeRoot = undefined;
        }
        continue;
      }
    }
    if (indent < 4 && thematic(line, at)) {
      flush();
      if (!containers.length) {
        activeRoot = undefined;
        const thematicRoot = rootFor(sourceOffset(line, visible), "thematic");
        if (thematicRoot) {
          thematicRoot.end = line.end;
        }
        activeRoot = undefined;
      }
      continue;
    }
    if (table) {
      for (const part of cells(line, at)) {
        emit({ kind: "inline", parts: [part] });
      }
      continue;
    }
    paragraph.push({ line, from: visible, to: body.length, lazy, tableEligible: indent < 4 });
  }
  if (fence && firstQuote >= 0 && /[\r\n]$/u.test(text)) {
    fence.end = fence.last;
  }
  const openFence = fence;
  endCode();
  flush();
  const definitions: Array<{ identifier: string; start: number; end: number }> = [];
  const defined = new Set<string>();
  let maxReferenceLength = 0;
  const prepared = blocks.map((block) => {
    if ("block" in block) {
      return block;
    }
    const value = joined(block.parts);
    const definition =
      block.kind === "paragraph" ? parseReferenceDefinitions(value) : { end: 0, definitions: [] };
    for (const entry of definition.definitions) {
      defined.add(entry.name);
      maxReferenceLength = Math.max(maxReferenceLength, entry.name.length);
    }
    const root = owners?.get(block);
    const definitionRanges = ownership ? translated(block.parts, definition.definitions) : [];
    for (let index = 0; index < definitionRanges.length; index++) {
      const range = expectDefined(definitionRanges[index], "Markdown definition range");
      const entry = expectDefined(definition.definitions[index], "Markdown definition");
      definitions.push({
        identifier: entry.name.toLowerCase(),
        start: range.start,
        end: range.end,
      });
    }
    if (root?.kind === "paragraph" && definition.definitions.length) {
      root.definitions = definitionRanges.map(({ start, end }) => ({
        start,
        end,
        kind: "definition",
        parts: 0,
      }));
      if (definition.end >= value.length) {
        root.onlyDefinitions = true;
      } else {
        root.start = expectDefined(
          translated(block.parts, [{ start: definition.end, end: definition.end }])[0],
          "Markdown definition boundary",
        ).start;
      }
    }
    return { block, value, definitionEnd: definition.end };
  });
  const regions: Region[] = [];
  const candidates = new Set<Root>();
  let unresolvedImageCodeStart: number | undefined;
  let lastReferenceCandidate: number | undefined;
  for (const entry of prepared) {
    if (!("value" in entry)) {
      regions.push(entry);
      continue;
    }
    const { block, value, definitionEnd } = entry;
    const facts: {
      referenceCandidate?: boolean;
      unresolvedImageCodeStart?: number;
      literalReferenceCandidate?: number;
    } = {};
    const inline = scanInlineCode(
      value.slice(definitionEnd),
      defined,
      maxReferenceLength,
      ownership ? facts : undefined,
    ).map((span) => ({ start: span.start + definitionEnd, end: span.end + definitionEnd }));
    for (const region of translated(block.parts, inline)) {
      regions.push(region);
    }
    if (!ownership) {
      continue;
    }
    const root = expectDefined(owners?.get(block), "Markdown scan position");
    if (facts.literalReferenceCandidate !== undefined) {
      const position = facts.literalReferenceCandidate + definitionEnd;
      lastReferenceCandidate = expectDefined(
        translated(block.parts, [{ start: position, end: position }])[0],
        "Markdown reference position",
      ).start;
    }
    if (facts.referenceCandidate) {
      candidates.add(root);
    }
    if (facts.unresolvedImageCodeStart !== undefined) {
      unresolvedImageCodeStart = Math.min(unresolvedImageCodeStart ?? Infinity, root.start);
    }
  }
  if (!ownership) {
    return regions;
  }
  return collectMarkdownOwnership(
    rawText,
    expectDefined(roots, "Markdown ownership roots"),
    definitions,
    regions,
    candidates,
    unresolvedImageCodeStart,
    openFence,
    lastReferenceCandidate,
  );
}

export function findMarkdownCodeRegions(
  text: string,
  options?: { syntax?: "commonmark" | "gfm" },
): Region[] {
  return /[`~\t]| {4}/u.test(text) ? scanMarkdown(text, options, false) : [];
}
export function findMarkdownCodeOwnership(
  text: string,
  options?: { syntax?: "commonmark" | "gfm" },
) {
  return scanMarkdown(text, options, true);
}

export function findMarkdownCodeSpans(text: string): Array<[number, number]> {
  return findMarkdownCodeRegions(text).map(({ start, end }) => [start, end]);
}
