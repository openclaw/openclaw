import { TextStyle } from "./zca-client.js";
const TAG_STYLE_MAP = {
  red: TextStyle.Red,
  orange: TextStyle.Orange,
  yellow: TextStyle.Yellow,
  green: TextStyle.Green,
  small: null,
  big: TextStyle.Big,
  underline: TextStyle.Underline
};
const INLINE_MARKERS = [
  {
    pattern: /`([^`\n]+)`/g,
    extractText: (match) => match[0],
    literal: true
  },
  {
    pattern: /\\([*_~#\\{}>+\-`])/g,
    extractText: (match) => match[1],
    literal: true
  },
  {
    pattern: new RegExp(`\\{(${Object.keys(TAG_STYLE_MAP).join("|")})\\}(.+?)\\{/\\1\\}`, "g"),
    extractText: (match) => match[2],
    resolveStyles: (match) => {
      const style = TAG_STYLE_MAP[match[1]];
      return style ? [style] : [];
    }
  },
  {
    pattern: /(?<!\*)\*\*\*(?=\S)([^\n]*?\S)(?<!\*)\*\*\*(?!\*)/g,
    extractText: (match) => match[1],
    resolveStyles: () => [TextStyle.Bold, TextStyle.Italic]
  },
  {
    pattern: /(?<!\*)\*\*(?![\s*])([^\n]*?\S)(?<!\*)\*\*(?!\*)/g,
    extractText: (match) => match[1],
    resolveStyles: () => [TextStyle.Bold]
  },
  {
    pattern: /(?<![\w_])__(?![\s_])([^\n]*?\S)(?<!_)__(?![\w_])/g,
    extractText: (match) => match[1],
    resolveStyles: () => [TextStyle.Bold]
  },
  {
    pattern: /(?<!~)~~(?=\S)([^\n]*?\S)(?<!~)~~(?!~)/g,
    extractText: (match) => match[1],
    resolveStyles: () => [TextStyle.StrikeThrough]
  },
  {
    pattern: /(?<!\*)\*(?![\s*])([^\n]*?\S)(?<!\*)\*(?!\*)/g,
    extractText: (match) => match[1],
    resolveStyles: () => [TextStyle.Italic]
  },
  {
    pattern: /(?<![\w_])_(?![\s_])([^\n]*?\S)(?<!_)_(?![\w_])/g,
    extractText: (match) => match[1],
    resolveStyles: () => [TextStyle.Italic]
  }
];
function parseZalouserTextStyles(input) {
  const allStyles = [];
  const escapeMap = [];
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const lineStyles = [];
  const processedLines = [];
  let activeFence = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const { text: unquotedLine, indent: baseIndent } = stripQuotePrefix(rawLine);
    if (activeFence) {
      const codeLine = activeFence.quoteIndent > 0 ? stripQuotePrefix(rawLine, activeFence.quoteIndent).text : rawLine;
      if (isClosingFence(codeLine, activeFence)) {
        activeFence = null;
        continue;
      }
      processedLines.push(
        escapeLiteralText(
          normalizeCodeBlockLeadingWhitespace(stripCodeFenceIndent(codeLine, activeFence.indent)),
          escapeMap
        )
      );
      continue;
    }
    let line = unquotedLine;
    const openingFence = resolveOpeningFence(rawLine);
    if (openingFence) {
      const fenceLine = openingFence.quoteIndent > 0 ? unquotedLine : rawLine;
      if (!hasClosingFence(lines, lineIndex + 1, openingFence)) {
        processedLines.push(escapeLiteralText(fenceLine, escapeMap));
        activeFence = openingFence;
        continue;
      }
      activeFence = openingFence;
      continue;
    }
    const outputLineIndex = processedLines.length;
    if (isIndentedCodeBlockLine(line)) {
      if (baseIndent > 0) {
        lineStyles.push({
          lineIndex: outputLineIndex,
          style: TextStyle.Indent,
          indentSize: baseIndent
        });
      }
      processedLines.push(escapeLiteralText(normalizeCodeBlockLeadingWhitespace(line), escapeMap));
      continue;
    }
    const { text: markdownLine, size: markdownPadding } = stripOptionalMarkdownPadding(line);
    const headingMatch = markdownLine.match(/^(#{1,4})\s(.*)$/);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      lineStyles.push({ lineIndex: outputLineIndex, style: TextStyle.Bold });
      if (depth === 1) {
        lineStyles.push({ lineIndex: outputLineIndex, style: TextStyle.Big });
      }
      if (baseIndent > 0) {
        lineStyles.push({
          lineIndex: outputLineIndex,
          style: TextStyle.Indent,
          indentSize: baseIndent
        });
      }
      processedLines.push(headingMatch[2]);
      continue;
    }
    const indentMatch = markdownLine.match(/^(\s+)(.*)$/);
    let indentLevel = 0;
    let content = markdownLine;
    if (indentMatch) {
      indentLevel = clampIndent(indentMatch[1].length);
      content = indentMatch[2];
    }
    const totalIndent = Math.min(5, baseIndent + indentLevel);
    if (/^[-*+]\s\[[ xX]\]\s/.test(content)) {
      if (totalIndent > 0) {
        lineStyles.push({
          lineIndex: outputLineIndex,
          style: TextStyle.Indent,
          indentSize: totalIndent
        });
      }
      processedLines.push(content);
      continue;
    }
    const orderedListMatch = content.match(/^(\d+)\.\s(.*)$/);
    if (orderedListMatch) {
      if (totalIndent > 0) {
        lineStyles.push({
          lineIndex: outputLineIndex,
          style: TextStyle.Indent,
          indentSize: totalIndent
        });
      }
      lineStyles.push({ lineIndex: outputLineIndex, style: TextStyle.OrderedList });
      processedLines.push(orderedListMatch[2]);
      continue;
    }
    const unorderedListMatch = content.match(/^[-*+]\s(.*)$/);
    if (unorderedListMatch) {
      if (totalIndent > 0) {
        lineStyles.push({
          lineIndex: outputLineIndex,
          style: TextStyle.Indent,
          indentSize: totalIndent
        });
      }
      lineStyles.push({ lineIndex: outputLineIndex, style: TextStyle.UnorderedList });
      processedLines.push(unorderedListMatch[1]);
      continue;
    }
    if (markdownPadding > 0) {
      if (baseIndent > 0) {
        lineStyles.push({
          lineIndex: outputLineIndex,
          style: TextStyle.Indent,
          indentSize: baseIndent
        });
      }
      processedLines.push(line);
      continue;
    }
    if (totalIndent > 0) {
      lineStyles.push({
        lineIndex: outputLineIndex,
        style: TextStyle.Indent,
        indentSize: totalIndent
      });
      processedLines.push(content);
      continue;
    }
    processedLines.push(line);
  }
  const segments = parseInlineSegments(processedLines.join("\n"));
  let plainText = "";
  for (const segment of segments) {
    const start = plainText.length;
    plainText += segment.text;
    for (const style of segment.styles) {
      allStyles.push({ start, len: segment.text.length, st: style });
    }
  }
  if (escapeMap.length > 0) {
    const escapeRegex = /\x01(\d+)\x02/g;
    const shifts = [];
    let cumulativeDelta = 0;
    for (const match of plainText.matchAll(escapeRegex)) {
      const escapeIndex = Number.parseInt(match[1], 10);
      cumulativeDelta += match[0].length - escapeMap[escapeIndex].length;
      shifts.push({ pos: (match.index ?? 0) + match[0].length, delta: cumulativeDelta });
    }
    for (const style of allStyles) {
      let startDelta = 0;
      let endDelta = 0;
      const end = style.start + style.len;
      for (const shift of shifts) {
        if (shift.pos <= style.start) {
          startDelta = shift.delta;
        }
        if (shift.pos <= end) {
          endDelta = shift.delta;
        }
      }
      style.start -= startDelta;
      style.len -= endDelta - startDelta;
    }
    plainText = plainText.replace(
      escapeRegex,
      (_match, index) => escapeMap[Number.parseInt(index, 10)]
    );
  }
  const finalLines = plainText.split("\n");
  let offset = 0;
  for (let lineIndex = 0; lineIndex < finalLines.length; lineIndex += 1) {
    const lineLength = finalLines[lineIndex].length;
    if (lineLength > 0) {
      for (const lineStyle of lineStyles) {
        if (lineStyle.lineIndex !== lineIndex) {
          continue;
        }
        if (lineStyle.style === TextStyle.Indent) {
          allStyles.push({
            start: offset,
            len: lineLength,
            st: TextStyle.Indent,
            indentSize: lineStyle.indentSize
          });
        } else {
          allStyles.push({ start: offset, len: lineLength, st: lineStyle.style });
        }
      }
    }
    offset += lineLength + 1;
  }
  return { text: plainText, styles: allStyles };
}
function clampIndent(spaceCount) {
  return Math.min(5, Math.max(1, Math.floor(spaceCount / 2)));
}
function stripOptionalMarkdownPadding(line) {
  const match = line.match(/^( {1,3})(?=\S)/);
  if (!match) {
    return { text: line, size: 0 };
  }
  return {
    text: line.slice(match[1].length),
    size: match[1].length
  };
}
function hasClosingFence(lines, startIndex, fence) {
  for (let index = startIndex; index < lines.length; index += 1) {
    const candidate = fence.quoteIndent > 0 ? stripQuotePrefix(lines[index], fence.quoteIndent).text : lines[index];
    if (isClosingFence(candidate, fence)) {
      return true;
    }
  }
  return false;
}
function resolveOpeningFence(line) {
  const directFence = parseFenceMarker(line);
  if (directFence) {
    return { ...directFence, quoteIndent: 0 };
  }
  const quoted = stripQuotePrefix(line);
  if (quoted.indent === 0) {
    return null;
  }
  const quotedFence = parseFenceMarker(quoted.text);
  if (!quotedFence) {
    return null;
  }
  return {
    ...quotedFence,
    quoteIndent: quoted.indent
  };
}
function stripQuotePrefix(line, maxDepth = Number.POSITIVE_INFINITY) {
  let cursor = 0;
  while (cursor < line.length && cursor < 3 && line[cursor] === " ") {
    cursor += 1;
  }
  let removedDepth = 0;
  let consumedCursor = cursor;
  while (removedDepth < maxDepth && consumedCursor < line.length && line[consumedCursor] === ">") {
    removedDepth += 1;
    consumedCursor += 1;
    if (line[consumedCursor] === " ") {
      consumedCursor += 1;
    }
  }
  if (removedDepth === 0) {
    return { text: line, indent: 0 };
  }
  return {
    text: line.slice(consumedCursor),
    indent: Math.min(5, removedDepth)
  };
}
function parseFenceMarker(line) {
  const match = line.match(/^([ ]{0,3})(`{3,}|~{3,})(.*)$/);
  if (!match) {
    return null;
  }
  const marker = match[2];
  const char = marker[0];
  if (char !== "`" && char !== "~") {
    return null;
  }
  return {
    char,
    length: marker.length,
    indent: match[1].length
  };
}
function isClosingFence(line, fence) {
  const match = line.match(/^([ ]{0,3})(`{3,}|~{3,})[ \t]*$/);
  if (!match) {
    return false;
  }
  return match[2][0] === fence.char && match[2].length >= fence.length;
}
function escapeLiteralText(input, escapeMap) {
  return input.replace(/[\\*_~{}`]/g, (ch) => {
    const index = escapeMap.length;
    escapeMap.push(ch);
    return `${index}`;
  });
}
function parseInlineSegments(text, inheritedStyles = []) {
  const segments = [];
  let cursor = 0;
  while (cursor < text.length) {
    const nextMatch = findNextInlineMatch(text, cursor);
    if (!nextMatch) {
      pushSegment(segments, text.slice(cursor), inheritedStyles);
      break;
    }
    if (nextMatch.match.index > cursor) {
      pushSegment(segments, text.slice(cursor, nextMatch.match.index), inheritedStyles);
    }
    const combinedStyles = [...inheritedStyles, ...nextMatch.styles];
    if (nextMatch.marker.literal) {
      pushSegment(segments, nextMatch.text, combinedStyles);
    } else {
      segments.push(...parseInlineSegments(nextMatch.text, combinedStyles));
    }
    cursor = nextMatch.match.index + nextMatch.match[0].length;
  }
  return segments;
}
function findNextInlineMatch(text, startIndex) {
  let bestMatch = null;
  for (const [priority, marker] of INLINE_MARKERS.entries()) {
    const regex = new RegExp(marker.pattern.source, marker.pattern.flags);
    regex.lastIndex = startIndex;
    const match = regex.exec(text);
    if (!match) {
      continue;
    }
    if (bestMatch && (match.index > bestMatch.match.index || match.index === bestMatch.match.index && priority > bestMatch.priority)) {
      continue;
    }
    bestMatch = {
      match,
      marker,
      text: marker.extractText(match),
      styles: marker.resolveStyles?.(match) ?? [],
      priority
    };
  }
  return bestMatch;
}
function pushSegment(segments, text, styles) {
  if (!text) {
    return;
  }
  const lastSegment = segments.at(-1);
  if (lastSegment && sameStyles(lastSegment.styles, styles)) {
    lastSegment.text += text;
    return;
  }
  segments.push({
    text,
    styles: [...styles]
  });
}
function sameStyles(left, right) {
  return left.length === right.length && left.every((style, index) => style === right[index]);
}
function normalizeCodeBlockLeadingWhitespace(line) {
  return line.replace(
    /^[ \t]+/,
    (leadingWhitespace) => leadingWhitespace.replace(/\t/g, "\xA0\xA0\xA0\xA0").replace(/ /g, "\xA0")
  );
}
function isIndentedCodeBlockLine(line) {
  return /^(?: {4,}|\t)/.test(line);
}
function stripCodeFenceIndent(line, indent) {
  let consumed = 0;
  let cursor = 0;
  while (cursor < line.length && consumed < indent && line[cursor] === " ") {
    cursor += 1;
    consumed += 1;
  }
  return line.slice(cursor);
}
export {
  parseZalouserTextStyles
};
