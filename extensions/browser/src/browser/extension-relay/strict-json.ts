import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Reject duplicate object keys before JSON.parse can silently keep the last value. */
function hasDuplicateJsonObjectKeys(text: string): boolean {
  const stack: Array<Set<string> | null> = [];
  let expectingKey = false;
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/u.test(text[index] ?? "")) {
      index += 1;
    }
  };
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < text.length) {
        const next = text[index++];
        if (escaped) {
          escaped = false;
        } else if (next === "\\") {
          escaped = true;
        } else if (next === '"') {
          break;
        }
      }
      const keys = stack.at(-1);
      if (expectingKey && keys) {
        let key: unknown;
        try {
          key = JSON.parse(text.slice(start, index));
        } catch {
          return false;
        }
        skipWhitespace();
        if (text[index] === ":" && typeof key === "string") {
          if (keys.has(key)) {
            return true;
          }
          keys.add(key);
          expectingKey = false;
        }
      }
      continue;
    }
    if (char === "{") {
      stack.push(new Set());
      expectingKey = true;
    } else if (char === "[") {
      stack.push(null);
      expectingKey = false;
    } else if (char === "}") {
      stack.pop();
      expectingKey = false;
    } else if (char === "]") {
      stack.pop();
      expectingKey = false;
    } else if (char === ",") {
      expectingKey = stack.at(-1) instanceof Set;
    }
    index += 1;
  }
  return false;
}

export function parseStrictJsonObject(text: string): Record<string, unknown> | null {
  if (hasDuplicateJsonObjectKeys(text)) {
    return null;
  }
  try {
    return asNullableRecord(JSON.parse(text));
  } catch {
    return null;
  }
}
