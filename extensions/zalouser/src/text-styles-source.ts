import { markdownToIR } from "openclaw/plugin-sdk/text-chunking";
import { isEscaped, protectLiteral, protectLocalInlineSyntax } from "./text-styles-inline.js";
import type { MarkdownIRWithBlockMetadata, TokenRegistry } from "./text-styles-shared.js";
import {
  sourceBlockquotePrefixLength,
  sourceContainerProjection,
  type MarkdownSource,
} from "./text-styles-source-spans.js";
import type { Style } from "./zca-constants.js";

export function restoreLeadingBlankLines(
  rendered: { text: string; styles: Style[] },
  { lines: sourceLines }: MarkdownSource,
): { text: string; styles: Style[] } {
  let sourceLeading = 0;
  for (const [lineIndex, line] of sourceLines.entries()) {
    if (lineIndex === sourceLines.length - 1) {
      break;
    }
    if (/^[ \t]*$/u.test(line) || /^(?: {0,3}>[ \t]?)+[ \t]*$/u.test(line)) {
      sourceLeading += 1;
    } else {
      break;
    }
  }
  const renderedLeading = rendered.text.match(/^\n*/u)?.[0].length ?? 0;
  const missing = Math.max(0, sourceLeading - renderedLeading);
  return missing === 0
    ? rendered
    : {
        text: `${"\n".repeat(missing)}${rendered.text}`,
        styles: rendered.styles.map((style) => ({ ...style, start: style.start + missing })),
      };
}

export function stripUnsupportedHeadingStyles(
  ir: MarkdownIRWithBlockMetadata,
  { ir: sourceIR, lines: sourceLines }: MarkdownSource,
): void {
  const unsupportedLines = new Set(
    (sourceIR.blocks ?? []).flatMap((block) =>
      block.kind === "heading" &&
      (block.headingOrigin === "setext" ||
        (block.headingLevel ?? 0) > 4 ||
        (block.start === block.end &&
          sourceAtxIsMarkerOnly(
            sourceLines[block.sourceStartLine ?? 0] ?? "",
            block.headingLevel ?? 1,
          ) &&
          !sourceAtxHasClosingRun(
            sourceLines[block.sourceStartLine ?? 0] ?? "",
            block.headingLevel ?? 1,
          )))
        ? [block.sourceStartLine]
        : [],
    ),
  );
  const unsupportedBlocks = (ir.blocks ?? []).filter(
    (block) => block.kind === "heading" && unsupportedLines.has(block.sourceStartLine),
  );
  ir.styles = ir.styles.filter(
    (span) =>
      !span.style.startsWith("heading_") ||
      !unsupportedBlocks.some((block) => block.start === span.start && block.end === span.end),
  );
}

export function sourceAtxIsMarkerOnly(line: string, level: number): boolean {
  const marker = "#".repeat(level);
  const markerOffset = line.indexOf(marker);
  const remainder = line.slice(Math.max(0, markerOffset) + marker.length).replace(/[ \t]/gu, "");
  return !remainder || /^#+$/u.test(remainder);
}

function sourceAtxHasClosingRun(line: string, level: number): boolean {
  const marker = "#".repeat(level);
  const markerOffset = line.indexOf(marker);
  return /^[ \t]+#+[ \t]*$/u.test(line.slice(Math.max(0, markerOffset) + marker.length));
}

export function parseSharedIR(source: string): MarkdownIRWithBlockMetadata {
  return markdownToIR(source, {
    autolink: false,
    enableHtmlUnderline: true,
    enableTaskLists: true,
    headingStyle: "rich",
    linkify: false,
    preserveSourceBlockSpacing: true,
    tableMode: "off",
  }) as MarkdownIRWithBlockMetadata;
}

export function protectInlineSyntaxOutsideCode(
  context: MarkdownSource,
  registry: TokenRegistry,
): string {
  const { ir, lines: sourceLines, lineStarts: sourceLineStarts } = context;
  const codeLines = new Set<number>();
  const thematicBreakLines = new Set<number>();
  const structuralPaddingLines = new Set<number>();
  const emptyAtxMarkers = new Map<number, string>();
  const closingAtxLines = new Set<number>();
  const blockquoteDepthByLine = new Map<number, number>();
  for (const block of ir.blocks ?? []) {
    if (block.kind === "blockquote") {
      for (let line = block.sourceStartLine ?? 0; line < (block.sourceEndLine ?? 0); line += 1) {
        blockquoteDepthByLine.set(
          line,
          Math.max(blockquoteDepthByLine.get(line) ?? 0, block.blockquoteDepth ?? 0),
        );
      }
    }
    if (block.kind === "heading" && block.headingOrigin === "atx" && block.start === block.end) {
      const lineIndex = block.sourceStartLine ?? 0;
      const marker = "#".repeat(block.headingLevel ?? 1);
      const line = sourceLines[lineIndex] ?? "";
      if (sourceAtxIsMarkerOnly(line, block.headingLevel ?? 1)) {
        emptyAtxMarkers.set(lineIndex, marker);
      } else {
        closingAtxLines.add(lineIndex);
      }
    } else if (block.kind === "heading" && block.headingOrigin === "atx") {
      closingAtxLines.add(block.sourceStartLine ?? 0);
    }
    if (block.kind === "thematic_break") {
      thematicBreakLines.add(block.sourceStartLine ?? 0);
      structuralPaddingLines.add(block.sourceStartLine ?? 0);
    } else if (block.kind === "heading" && block.headingOrigin === "setext") {
      structuralPaddingLines.add((block.sourceEndLine ?? 1) - 1);
    }
    if (block.kind !== "code_block") {
      continue;
    }
    for (let line = block.sourceStartLine ?? 0; line < (block.sourceEndLine ?? 0); line += 1) {
      codeLines.add(line);
    }
  }
  const listLines = new Set<number>();
  const listMarkerColumns = new Map<number, Set<number>>();
  const taskBrackets = new Map<number, Set<number>>();
  for (const item of ir.listItems ?? []) {
    for (let line = item.sourceStartLine ?? 0; line < (item.sourceEndLine ?? 0); line += 1) {
      listLines.add(line);
    }
    if (item.sourceMarker && item.sourceStartLine !== undefined) {
      const markers = listMarkerColumns.get(item.sourceStartLine) ?? new Set<number>();
      markers.add(item.sourceMarker.start - (sourceLineStarts[item.sourceStartLine] ?? 0));
      listMarkerColumns.set(item.sourceStartLine, markers);
    }
    if (item.markerOnly && item.sourceStartLine !== undefined) {
      structuralPaddingLines.add(item.sourceStartLine);
    }
    if (item.task && item.sourceStartLine !== undefined && item.sourceEndLine !== undefined) {
      for (let lineIndex = item.sourceStartLine; lineIndex < item.sourceEndLine; lineIndex += 1) {
        const line = sourceLines[lineIndex] ?? "";
        const match = /\[[ xX]\](?:[ \t]|$)/u.exec(line);
        if (!match) {
          continue;
        }
        const brackets = taskBrackets.get(lineIndex) ?? new Set<number>();
        brackets.add(match.index);
        taskBrackets.set(lineIndex, brackets);
        break;
      }
    }
  }

  return sourceLines
    .map((rawLine, lineIndex) => {
      if (codeLines.has(lineIndex)) {
        return rawLine;
      }
      if (/^[ \t]+$/u.test(rawLine)) {
        return "";
      }
      let line = rawLine;
      const emptyMarker = emptyAtxMarkers.get(lineIndex);
      if (emptyMarker) {
        const heading = (ir.blocks ?? []).find(
          (block) => block.kind === "heading" && block.sourceStartLine === lineIndex,
        );
        const projection = sourceContainerProjection(
          context,
          lineIndex,
          heading?.blockquoteDepth ?? 0,
        );
        const markerOffset = rawLine.indexOf(emptyMarker, projection.offset);
        const literalPadding = `${" ".repeat(projection.residual)}${rawLine.slice(
          projection.offset,
          markerOffset,
        )}`;
        const closingMarker = /^[ \t]+(#+)[ \t]*$/u.exec(
          rawLine.slice(markerOffset + emptyMarker.length),
        )?.[1];
        const literal =
          emptyMarker.length > 4
            ? `${literalPadding}${rawLine.slice(markerOffset)}`
            : (closingMarker ?? `${literalPadding}${emptyMarker}`);
        line = `${rawLine.slice(0, markerOffset)}${emptyMarker} ${protectLiteral(
          registry,
          literal,
        )}`;
      }
      if (closingAtxLines.has(lineIndex)) {
        line = line.replace(
          /([ \t]+)(#+)(?=[ \t]*$)/u,
          (_match, spacing, marker) => `${spacing}${protectLiteral(registry, marker)}`,
        );
      }
      if (
        !listLines.has(lineIndex) &&
        sourceBlockquotePrefixLength(rawLine) === 0 &&
        /^( {1,3})(?=\S)/u.test(line) &&
        !/^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|[-*+][ \t]|(?:=+|-+)[ \t]*$|(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$)/u.test(
          line,
        )
      ) {
        line = line.replace(/^( {1,3})/u, (padding) => protectLiteral(registry, padding));
      }
      line = protectLocalInlineSyntax(
        line,
        registry,
        taskBrackets.get(lineIndex),
        structuralPaddingLines.has(lineIndex) || /^(?: {0,3}>[ \t]?)+[ \t]*$/u.test(rawLine),
      );
      line = protectResidualBlockPadding(
        line,
        registry,
        closingAtxLines.has(lineIndex) || emptyAtxMarkers.has(lineIndex),
        !listLines.has(lineIndex),
        blockquoteDepthByLine.get(lineIndex) ?? 0,
      );
      return thematicBreakLines.has(lineIndex)
        ? line
        : protectUnpairedDelimiterRuns(line, registry, listMarkerColumns.get(lineIndex));
    })
    .join("\n");
}

function protectResidualBlockPadding(
  line: string,
  registry: TokenRegistry,
  atxHeading: boolean,
  protectQuotePadding: boolean,
  blockquoteDepth: number,
): string {
  let protectedLine = line;
  let cursor = 0;
  let consumedBlockquotes = 0;
  if (protectQuotePadding) {
    while (cursor < protectedLine.length) {
      let marker = cursor;
      while (
        marker < protectedLine.length &&
        marker - cursor < 3 &&
        protectedLine[marker] === " "
      ) {
        marker += 1;
      }
      if (protectedLine[marker] !== ">") {
        break;
      }
      consumedBlockquotes += 1;
      const whitespaceStart = marker + 1;
      const whitespace = /^[ \t]+/u.exec(protectedLine.slice(whitespaceStart))?.[0] ?? "";
      const remainingContent = protectedLine.slice(whitespaceStart + whitespace.length);
      const structuralPadding = atxHeading || consumedBlockquotes < blockquoteDepth;
      if (!structuralPadding && whitespace.length > 1 && remainingContent) {
        protectedLine = `${protectedLine.slice(0, whitespaceStart + 1)}${protectLiteral(
          registry,
          whitespace.slice(1),
        )}${protectedLine.slice(whitespaceStart + whitespace.length)}`;
        break;
      }
      cursor = whitespaceStart + whitespace.length;
    }
  }
  if (atxHeading) {
    protectedLine = protectedLine.replace(/(#{1,6})([ \t]+)/u, (_match, marker, whitespace) =>
      whitespace.length > 1
        ? `${marker} ${protectLiteral(registry, whitespace.slice(1))}`
        : `${marker}${whitespace}`,
    );
  }
  return protectedLine;
}

function protectUnpairedDelimiterRuns(
  line: string,
  registry: TokenRegistry,
  preservedOffsets: ReadonlySet<number> = new Set(),
): string {
  let protectedLine = line;
  const replacements: Array<{
    end: number;
    literal: string;
    literalFirst: boolean;
    matched: string;
    start: number;
  }> = [];
  for (const marker of ["*", "_", "~"] as const) {
    const pattern = new RegExp(`${marker === "*" ? "\\*" : marker}+`, "gu");
    const matches = [...line.matchAll(pattern)]
      .filter((match) => !preservedOffsets.has(match.index) && !isEscaped(line, match.index))
      .map((match) => ({
        start: match.index,
        length: match[0].length,
        remaining: match[0].length,
        literalFirst: false,
        both: false,
      }));
    const stack: Array<(typeof matches)[number]> = [];
    for (const match of matches) {
      const previous = line[match.start - 1] ?? "";
      const next = line[match.start + match.length] ?? "";
      const previousWhitespace = !previous || /\s/u.test(previous);
      const nextWhitespace = !next || /\s/u.test(next);
      const previousPunctuation = /[\p{P}\p{S}]/u.test(previous);
      const nextPunctuation = /[\p{P}\p{S}]/u.test(next);
      const leftFlanking =
        !nextWhitespace && (!nextPunctuation || previousWhitespace || previousPunctuation);
      const rightFlanking =
        !previousWhitespace && (!previousPunctuation || nextWhitespace || nextPunctuation);
      const canOpen =
        marker === "_" ? leftFlanking && (!rightFlanking || previousPunctuation) : leftFlanking;
      const canClose =
        marker === "_" ? rightFlanking && (!leftFlanking || nextPunctuation) : rightFlanking;
      match.literalFirst = canOpen;
      match.both = canOpen && canClose;
      if (canClose) {
        while (match.remaining > 0 && stack.length > 0) {
          const openingIndex = stack.findLastIndex(
            (candidate) =>
              !(
                (candidate.both || match.both) &&
                (candidate.length + match.length) % 3 === 0 &&
                candidate.length % 3 !== 0 &&
                match.length % 3 !== 0
              ),
          );
          const opening = stack[openingIndex];
          if (!opening) {
            break;
          }
          const matched = Math.min(match.remaining, opening.remaining);
          match.literalFirst = false;
          match.remaining -= matched;
          opening.remaining -= matched;
          if (opening.remaining === 0) {
            stack.splice(openingIndex, 1);
          }
        }
      }
      if (canOpen && match.remaining > 0) {
        stack.push(match);
      }
    }
    for (const match of matches.toReversed()) {
      const unmatched = match.remaining;
      if (unmatched === 0) {
        continue;
      }
      replacements.push({
        start: match.start,
        end: match.start + match.length,
        literal: marker.repeat(unmatched),
        literalFirst: match.literalFirst,
        matched: marker.repeat(match.length - unmatched),
      });
    }
  }
  for (const replacement of replacements.toSorted((left, right) => right.start - left.start)) {
    const literal = protectLiteral(registry, replacement.literal);
    const text = replacement.literalFirst
      ? `${literal}${replacement.matched}`
      : `${replacement.matched}${literal}`;
    protectedLine = `${protectedLine.slice(0, replacement.start)}${text}${protectedLine.slice(
      replacement.end,
    )}`;
  }
  return protectedLine;
}
