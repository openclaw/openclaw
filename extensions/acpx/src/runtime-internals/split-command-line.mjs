export function splitCommandLine(value) {
  const parts = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      if (quote === "'") {
        current += ch;
        continue;
      }
      if (quote === '"') {
        const next = value[index + 1];
        if (next === '"' || next === "\\") {
          escaping = true;
          continue;
        }
        // Preserve literal backslashes inside double-quoted Windows/custom paths.
        current += ch;
        continue;
      }
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error("Invalid agent command: unterminated quote");
  }
  if (current.length > 0) {
    parts.push(current);
  }
  if (parts.length === 0) {
    throw new Error("Invalid agent command: empty command");
  }
  return {
    command: parts[0],
    args: parts.slice(1),
  };
}
