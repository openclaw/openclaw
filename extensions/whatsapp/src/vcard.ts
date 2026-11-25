const ALLOWED_VCARD_KEYS = new Set(["FN", "N", "TEL"]);

export function parseVcard(vcard?: string) {
  if (!vcard) {
    return { phones: [] };
  }
  const lines = vcard.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  let nameFromN: string | undefined;
  let nameFromFn: string | undefined;
  const phones: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const colonIndex = findVcardValueSeparator(line);
    if (colonIndex === -1) {
      continue;
    }
    const key = line.slice(0, colonIndex).toUpperCase();
    const rawValue = line.slice(colonIndex + 1).trim();
    if (!rawValue) {
      continue;
    }
    const baseKey = normalizeVcardKey(key);
    if (!baseKey || !ALLOWED_VCARD_KEYS.has(baseKey)) {
      continue;
    }
    // Consume escape pairs before interpreting bare semicolons as N component separators.
    const value = rawValue
      .replace(/\\[\\,;nN]|;/g, (token) => {
        if (token === ";") {
          return baseKey === "N" ? " " : token;
        }
        return token === "\\n" || token === "\\N" ? " " : token.slice(1);
      })
      .trim();
    if (!value) {
      continue;
    }
    if (baseKey === "FN" && !nameFromFn) {
      nameFromFn = normalizeVcardName(value);
      continue;
    }
    if (baseKey === "N" && !nameFromN) {
      nameFromN = normalizeVcardName(value);
      continue;
    }
    if (baseKey === "TEL") {
      const phone = value.toLowerCase().startsWith("tel:") ? value.slice(4).trim() : value;
      if (phone) {
        phones.push(phone);
      }
    }
  }
  return { name: nameFromFn ?? nameFromN, phones };
}

function findVcardValueSeparator(line: string): number {
  let inQuotes = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ":" && !inQuotes) {
      return index;
    }
  }
  return -1;
}

function normalizeVcardKey(key: string): string | undefined {
  const [primary] = key.split(";");
  if (!primary) {
    return undefined;
  }
  const segments = primary.split(".");
  return segments[segments.length - 1] || undefined;
}

function normalizeVcardName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
