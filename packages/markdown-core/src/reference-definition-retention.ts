export function findReferenceDefinitionRetention(
  text: string,
  definitions: readonly { identifier: string; start: number; end: number }[],
) {
  const unsettledDefinitionStarts = definitions
    .filter((definition) => canStillHaveReferenceTitle(text, definition.end))
    .map(({ start }) => start);
  // Expanded labels cannot be serialized as carried CommonMark definitions (999 source
  // characters maximum); keep their original source just like unfinished titles.
  const retainStart = definitions.reduce(
    (offset, { identifier, start }) => (identifier.length > 999 ? Math.min(offset, start) : offset),
    Math.min(text.length, ...unsettledDefinitionStarts),
  );
  return { unsettledDefinitionStarts, retainStart };
}

function canStillHaveReferenceTitle(text: string, start: number): boolean {
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
  return hasUnclosedTitle(text, titleStart);
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

function hasUnclosedTitle(text: string, start: number): boolean {
  if (start === text.length) {
    return true;
  }
  const opening = text[start];
  if (opening !== '"' && opening !== "'" && opening !== "(") {
    return false;
  }
  const closing = opening === "(" ? ")" : opening;
  let escaped = false;
  for (let cursor = start + 1; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === closing) {
      return false;
    }

    const lineEndingWidth = getLineEndingWidth(text, cursor);
    if (lineEndingWidth > 0) {
      let nextLine = cursor + lineEndingWidth;
      while (text[nextLine] === " " || text[nextLine] === "\t") {
        nextLine += 1;
      }
      if (getLineEndingWidth(text, nextLine) > 0) {
        return false;
      }
      cursor += lineEndingWidth - 1;
    }
  }
  return true;
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
