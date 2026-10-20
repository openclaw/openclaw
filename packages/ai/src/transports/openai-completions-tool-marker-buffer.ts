import { findMarkdownCodeRegions } from "../../../markdown-core/src/reasoning-tags.js";

const TOOL_CALL_STREAM_MARKERS = [
  "<tool_call>",
  "<tool_calls>",
  "<function_call>",
  "<function_calls>",
];
const MAX_TOOL_CALL_MARKER_BUFFER_CHARS = 4_096;

function findTrailingToolCallMarkerStart(text: string, precedingLineIsWhitespace: boolean) {
  const trimmedEnd = text.trimEnd();
  const trailingWhitespaceLength = text.length - trimmedEnd.length;
  let markerStart = null;
  let markerLength = 0;

  for (const marker of TOOL_CALL_STREAM_MARKERS) {
    for (let prefixLength = marker.length; prefixLength > 0; prefixLength -= 1) {
      if (trailingWhitespaceLength > 0 && prefixLength !== marker.length) {
        continue;
      }
      const prefix = marker.slice(0, prefixLength);
      if (!trimmedEnd.endsWith(prefix) || prefixLength <= markerLength) {
        continue;
      }
      markerStart = trimmedEnd.length - prefixLength;
      markerLength = prefixLength;
      break;
    }
  }

  if (markerStart === null) {
    return null;
  }
  const lineBreakIndex = Math.max(
    text.lastIndexOf("\n", markerStart - 1),
    text.lastIndexOf("\r", markerStart - 1),
  );
  const linePrefix = text.slice(lineBreakIndex + 1, markerStart);
  const startsProtocolLine =
    /^[\t ]*$/.test(linePrefix) && (lineBreakIndex >= 0 || precedingLineIsWhitespace);
  if (!startsProtocolLine) {
    return null;
  }

  let pendingStart = markerStart;
  while (pendingStart > 0 && /\s/.test(text[pendingStart - 1] ?? "")) {
    pendingStart -= 1;
  }
  if (text.length - markerStart > MAX_TOOL_CALL_MARKER_BUFFER_CHARS) {
    return null;
  }
  return text.length - pendingStart <= MAX_TOOL_CALL_MARKER_BUFFER_CHARS
    ? pendingStart
    : markerStart;
}

function updateLineWhitespaceState(current: boolean, text: string) {
  let lineIsWhitespace = current;
  for (const char of text) {
    if (char === "\n" || char === "\r") {
      lineIsWhitespace = true;
    } else if (char !== " " && char !== "\t") {
      lineIsWhitespace = false;
    }
  }
  return lineIsWhitespace;
}

export function createOpenAICompletionsToolMarkerBuffer(
  publish: (text: string) => void,
  precedingText: () => string,
) {
  let pending = "";
  let lineIsWhitespace = true;

  return {
    push(text: string) {
      if (!text) {
        return;
      }
      const combined = pending + text;
      pending = "";
      const pendingStart = findTrailingToolCallMarkerStart(combined, lineIsWhitespace);
      if (pendingStart === null) {
        lineIsWhitespace = updateLineWhitespaceState(lineIsWhitespace, combined);
        publish(combined);
        return;
      }
      const publishable = combined.slice(0, pendingStart);
      pending = combined.slice(pendingStart);
      if (publishable) {
        lineIsWhitespace = updateLineWhitespaceState(lineIsWhitespace, publishable);
        publish(publishable);
      }
    },
    discard() {
      // A native call disambiguates a protocol prefix, not a Markdown example.
      // Scan only at this boundary; token-sized pushes do not reparse prior prose.
      if (pending) {
        const prefix = precedingText();
        const markerAt = prefix.length + pending.indexOf("<");
        if (
          findMarkdownCodeRegions(prefix + pending).some(
            (region) => markerAt >= region.start && markerAt < region.end,
          )
        ) {
          this.flush();
        }
      }
      pending = "";
      lineIsWhitespace = true;
    },
    boundary() {
      this.flush();
      lineIsWhitespace = true;
    },
    flush() {
      if (!pending) {
        return;
      }
      const text = pending;
      pending = "";
      lineIsWhitespace = updateLineWhitespaceState(lineIsWhitespace, text);
      publish(text);
    },
  };
}
