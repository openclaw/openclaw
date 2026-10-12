// JSON values from CLI output, with complete line-start objects retained amid diagnostics.
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isJsonObjectRecordStart(text, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = text[cursor];
    if (char === "\n" || char === "\r") {
      return true;
    }
    if (char !== " " && char !== "\t") {
      return false;
    }
  }
  return true;
}

function parseJsonObjectsFromText(text) {
  const payloads = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{" || !isJsonObjectRecordStart(text, start)) {
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < text.length; end += 1) {
      const char = text[end];
      if (inString) {
        if (escaped) {
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
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const parsed = parseJson(text.slice(start, end + 1));
          if (parsed !== undefined) {
            payloads.push(parsed);
          }
          start = end;
          break;
        }
      }
    }
  }
  return payloads;
}

export function parseJsonOutputValues(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  const parsed = parseJson(trimmed);
  if (parsed !== undefined) {
    return [parsed];
  }
  return parseJsonObjectsFromText(trimmed);
}
