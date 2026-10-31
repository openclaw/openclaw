import { expectDefined } from "@openclaw/normalization-core";
export type MarkdownCodeRegion = { start: number; end: number; block: boolean };
type Region = MarkdownCodeRegion;
export type Root = {
  start: number;
  end: number;
  kind: string;
  parts: number;
  firstContent?: number;
  definitions?: Root[];
  onlyDefinitions?: boolean;
};
export type MarkdownCodeOwnership = {
  regions: Region[];
  codeSpans: Array<[number, number]>;
  hasReferenceCandidate: boolean;
  retainStart: number;
  unsettledParagraph?: true;
  completedParagraphs: Array<{ start: number; end: number; hasReferenceCandidate: boolean }>;
  definitions: Array<{ identifier: string; start: number; end: number }>;
  unsettledDefinitionStarts: number[];
  continuation?: { offset: number; context: string };
  unresolvedImageCodeStart?: number;
};
export function collectMarkdownOwnership(
  text: string,
  roots: Root[],
  definitions: MarkdownCodeOwnership["definitions"],
  regions: Region[],
  candidates: Set<Root>,
  unresolvedImageCodeStart: number | undefined,
  openFence: { char: string; size: number } | undefined,
  lastReferenceCandidate: number | undefined,
): MarkdownCodeOwnership {
  const metadataRoots: Root[] = [];
  for (const root of roots) {
    if (root.definitions) {
      for (const definition of root.definitions) {
        metadataRoots.push(definition);
      }
    }
    if (!root.onlyDefinitions) {
      metadataRoots.push(root);
    }
  }
  let retainStart = metadataRoots.at(-1)?.start ?? text.length;
  const last = metadataRoots.at(-1);
  const completeEnd = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
  if (last?.kind === "list" && last.start >= completeEnd && metadataRoots.at(-2)?.kind === "list") {
    retainStart = expectDefined(metadataRoots.at(-2), "Markdown scan position").start;
  }
  if (last?.kind === "table" && last.end === text.length) {
    const previous = metadataRoots.at(-2);
    if (
      previous?.kind === "paragraph" &&
      !/(?:\r\n|\r(?!\n)|\n)[ \t]*[\r\n]/u.test(text.slice(previous.end, last.start))
    ) {
      retainStart = Math.min(retainStart, previous.start);
    }
  }
  const unsettledDefinitionStarts: number[] = [];
  if (definitions.length) {
    const suffix = indexTitleSuffix(text);
    for (const definition of definitions) {
      if (canStillHaveReferenceTitle(text, definition.end, suffix)) {
        unsettledDefinitionStarts.push(definition.start);
      }
    }
  }
  for (const start of unsettledDefinitionStarts) {
    retainStart = Math.min(retainStart, start);
  }
  for (const definition of definitions) {
    if (definition.identifier.length > 999) {
      retainStart = Math.min(retainStart, definition.start);
    }
  }
  if (unresolvedImageCodeStart !== undefined) {
    retainStart = Math.min(retainStart, unresolvedImageCodeStart);
  }
  for (const root of metadataRoots) {
    if (root.start <= retainStart && root.end >= retainStart) {
      retainStart = root.start;
    }
  }
  const completedParagraphs: Array<{ start: number; end: number; hasReferenceCandidate: boolean }> =
    [];
  for (let i = 0; i + 1 < metadataRoots.length; i++) {
    const root = expectDefined(metadataRoots[i], "Markdown scan position"),
      next = expectDefined(metadataRoots[i + 1], "Markdown scan position");
    if (
      root.kind === "paragraph" &&
      /(?:\r\n|\r(?!\n)|\n)[ \t]*[\r\n]/u.test(text.slice(root.end, next.start))
    ) {
      completedParagraphs.push({
        start: root.start,
        end: next.start,
        hasReferenceCandidate: candidates.has(root),
      });
    }
  }
  let continuation: { offset: number; context: string } | undefined;
  if (last && retainStart >= last.start && !/\r(?!\n)/u.test(text)) {
    const offset = text.lastIndexOf("\n", last.end - 1) + 1;
    if (openFence && last.kind === "fence" && text.lastIndexOf("\n") + 1 > last.start) {
      continuation = {
        offset: text.lastIndexOf("\n") + 1,
        context: openFence.char.repeat(openFence.size) + "\n",
      };
    } else if (offset > last.start && last.kind === "indented") {
      continuation = { offset, context: "    x\n" };
    } else if (
      offset > last.start &&
      last.kind === "quote" &&
      last.parts === 1 &&
      last.firstContent !== undefined
    ) {
      const prefix = text.slice(last.firstContent, offset);
      if (!/[`|[]|\][(:]/u.test(prefix)) {
        continuation = { offset, context: text.slice(last.start, last.firstContent) + "x\n" };
      }
    }
  }
  return {
    regions,
    codeSpans: regions.map(({ start, end }): [number, number] => [start, end]),
    hasReferenceCandidate:
      lastReferenceCandidate !== undefined && lastReferenceCandidate >= retainStart,
    retainStart,
    ...(last?.kind === "paragraph" && retainStart <= last.start
      ? { unsettledParagraph: true as const }
      : {}),
    completedParagraphs,
    definitions,
    unsettledDefinitionStarts,
    ...(continuation ? { continuation } : {}),
    ...(unresolvedImageCodeStart === undefined ? {} : { unresolvedImageCodeStart }),
  };
}
function canStillHaveReferenceTitle(
  text: string,
  start: number,
  suffix: ReturnType<typeof indexTitleSuffix>,
): boolean {
  let cursor = start;
  while (text[cursor] === " " || text[cursor] === "\t") {
    cursor += 1;
  }
  if (cursor === text.length) {
    return true;
  }

  const lineEndingWidth = getLineEndingWidth(text, cursor);
  if (lineEndingWidth > 0) {
    cursor += lineEndingWidth;
    if (cursor === text.length) {
      return true;
    }
  }

  const titleStart = findPossibleTitleStart(text, cursor);
  if (titleStart === undefined) {
    return false;
  }
  const closing = text[titleStart] === "(" ? ")" : text.charAt(titleStart);
  return (
    titleStart === text.length ||
    (suffix.lastBlank <= titleStart && (suffix.lastClosing.get(closing) ?? -1) <= titleStart)
  );
}

function findPossibleTitleStart(text: string, start: number): number | undefined {
  let cursor = skipContainerPrefixes(text, start);

  while (text[cursor] === " " || text[cursor] === "\t") {
    cursor += 1;
  }
  if (cursor === text.length) {
    return cursor;
  }
  const opening = text[cursor];
  return opening === '"' || opening === "'" || opening === "(" ? cursor : undefined;
}

function skipContainerPrefixes(text: string, start: number) {
  let cursor = start;
  while (cursor < text.length) {
    let markerStart = cursor;
    while (text[markerStart] === " " || text[markerStart] === "\t") {
      markerStart += 1;
    }

    if (text[markerStart] === ">") {
      cursor = markerStart + 1;
      if (text[cursor] === " " || text[cursor] === "\t") {
        cursor += 1;
      }
      continue;
    }

    const markerEnd = listMarkerEnd(text, markerStart);
    if (markerEnd > markerStart) {
      cursor = markerEnd;
      while (text[cursor] === " " || text[cursor] === "\t") {
        cursor += 1;
      }
      continue;
    }
    break;
  }
  return cursor;
}

function listMarkerEnd(text: string, start: number) {
  const first = text[start] ?? "";
  let markerEnd = start;
  if (first === "-" || first === "+" || first === "*") {
    markerEnd += 1;
  } else if (first >= "0" && first <= "9") {
    while ((text[markerEnd] ?? "") >= "0" && (text[markerEnd] ?? "") <= "9") {
      markerEnd += 1;
    }
    const delimiter = text[markerEnd] ?? "";
    if (markerEnd - start > 9 || (delimiter !== "." && delimiter !== ")")) {
      return start;
    }
    markerEnd += 1;
  } else {
    return start;
  }
  const trailingSpace = text[markerEnd];
  return trailingSpace === " " || trailingSpace === "\t" ? markerEnd : start;
}

/** Every pending title asks the same suffix question; visit those bytes once. */
function indexTitleSuffix(text: string) {
  const lastClosing = new Map<string, number>();
  let lastBlank = -1;
  let escaped = false;
  for (let cursor = 0; cursor < text.length; cursor++) {
    const character = text.charAt(cursor);
    if (!escaped && (character === '"' || character === "'" || character === ")")) {
      lastClosing.set(character, cursor);
    }
    escaped = !escaped && character === "\\";
    const width = getLineEndingWidth(text, cursor);
    if (width) {
      let next = cursor + width;
      while (text[next] === " " || text[next] === "\t") {
        next++;
      }
      if (getLineEndingWidth(text, next)) {
        lastBlank = cursor;
      }
      cursor += width - 1;
    }
  }
  return { lastClosing, lastBlank };
}

function getLineEndingWidth(text: string, index: number): number {
  if (text[index] === "\n") {
    return 1;
  }
  if (text[index] !== "\r") {
    return 0;
  }
  return text[index + 1] === "\n" ? 2 : 1;
}
