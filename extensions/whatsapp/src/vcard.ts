const ALLOWED_VCARD_KEYS = new Set(["FN", "N", "TEL"]);

export function parseVcard(vcard?: string) {
  if (!vcard) {
    return { phones: [] };
  }
  const lines = vcard.split(/\r?\n/);
  let nameFromN: string | undefined;
  let nameFromFn: string | undefined;
  const phones: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const colonIndex = line.indexOf(":");
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
    const value = rawValue.replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").trim();
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

function normalizeVcardKey(key: string): string | undefined {
  const [primary] = key.split(";");
  if (!primary) {
    return undefined;
  }
  const segments = primary.split(".");
  return segments[segments.length - 1] || undefined;
}

function normalizeVcardName(value: string): string {
  return value.replace(/;/g, " ").replace(/\s+/g, " ").trim();
}
