// Structural, allocation-free scan of a raw Claude stream-json line, used to
// classify parent versus forwarded-subagent traffic before the parent's turn
// budget charges the line and therefore before it is decoded.
//
// A substring search is not enough: `"parent_tool_use_id":` can legitimately
// appear at a nested object level inside a genuine parent record, and exempting
// such a line would leave accounting and parent-lane handling disagreeing about
// who owns it. This walks the top-level members only, so its verdict matches
// the decoded `isClaudeSubagentRecord` check without paying for a parse.

const PARENT_TOOL_USE_ID_KEY = '"parent_tool_use_id"';

function skipJsonWhitespace(line: string, index: number): number {
  let cursor = index;
  while (cursor < line.length) {
    const code = line.charCodeAt(cursor);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      break;
    }
    cursor += 1;
  }
  return cursor;
}

/** Index just past the closing quote, or -1 when the string never closes. */
function skipJsonString(line: string, index: number): number {
  let cursor = index + 1;
  while (cursor < line.length) {
    const char = line[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === '"') {
      return cursor + 1;
    }
    cursor += 1;
  }
  return -1;
}

/** Index just past the value starting at `index`, or -1 when it never closes. */
function skipJsonValue(line: string, index: number): number {
  const char = line[index];
  if (char === '"') {
    return skipJsonString(line, index);
  }
  if (char === "{" || char === "[") {
    let depth = 0;
    let cursor = index;
    while (cursor < line.length) {
      const current = line[cursor];
      if (current === '"') {
        cursor = skipJsonString(line, cursor);
        if (cursor === -1) {
          return -1;
        }
        continue;
      }
      if (current === "{" || current === "[") {
        depth += 1;
      } else if (current === "}" || current === "]") {
        depth -= 1;
        if (depth === 0) {
          return cursor + 1;
        }
      }
      cursor += 1;
    }
    return -1;
  }
  // Number, boolean or null: ends at the next structural character.
  let cursor = index;
  while (cursor < line.length) {
    const current = line[cursor];
    if (current === "," || current === "}" || current === "]") {
      return cursor;
    }
    cursor += 1;
  }
  return -1;
}

/**
 * Recognizes forwarded subagent traffic from the raw JSONL line.
 *
 * Returns true only when the line is one whole top-level JSON object whose own
 * `parent_tool_use_id` member is present and not null — exactly the condition
 * `isClaudeSubagentRecord` applies to the decoded record. Anything this scan
 * cannot resolve that way (a nested match, a banner-prefixed line, two objects
 * on one line, malformed JSON) returns false, so the line is charged and
 * assembled as parent traffic. Erring toward charging is safe; erring toward
 * exempting is the accounting/handling split this exists to prevent.
 */
export function isClaudeSubagentJsonlLine(line: string): boolean {
  // Most lines never mention the field; reject those without walking them.
  if (!line.includes(PARENT_TOOL_USE_ID_KEY)) {
    return false;
  }
  let cursor = skipJsonWhitespace(line, 0);
  if (line[cursor] !== "{") {
    return false;
  }
  cursor = skipJsonWhitespace(line, cursor + 1);
  let subagent = false;
  while (cursor < line.length) {
    if (line[cursor] === "}") {
      break;
    }
    if (line[cursor] !== '"') {
      return false;
    }
    const keyStart = cursor;
    const keyEnd = skipJsonString(line, cursor);
    if (keyEnd === -1) {
      return false;
    }
    cursor = skipJsonWhitespace(line, keyEnd);
    if (line[cursor] !== ":") {
      return false;
    }
    cursor = skipJsonWhitespace(line, cursor + 1);
    if (
      keyEnd - keyStart === PARENT_TOOL_USE_ID_KEY.length &&
      line.startsWith(PARENT_TOOL_USE_ID_KEY, keyStart)
    ) {
      // Duplicate keys resolve last-wins in `JSON.parse`, so keep scanning
      // rather than returning on the first match.
      subagent = !line.startsWith("null", cursor);
    }
    const valueEnd = skipJsonValue(line, cursor);
    if (valueEnd === -1) {
      return false;
    }
    cursor = skipJsonWhitespace(line, valueEnd);
    if (line[cursor] === ",") {
      cursor = skipJsonWhitespace(line, cursor + 1);
      continue;
    }
    if (line[cursor] !== "}") {
      return false;
    }
    break;
  }
  if (line[cursor] !== "}") {
    return false;
  }
  // A second object or a trailing banner on the same line decodes into more
  // than one record, and one line-level verdict cannot own both.
  return skipJsonWhitespace(line, cursor + 1) >= line.length && subagent;
}
