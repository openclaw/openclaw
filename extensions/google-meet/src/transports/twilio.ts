import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

const DTMF_CHARACTERS = new Set("0123456789*#wWpP,");

function isAsciiDigits(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (!char || char < "0" || char > "9") {
      return false;
    }
  }
  return true;
}

function isDialInNumber(value: string): boolean {
  const digits = value.startsWith("+") ? value.slice(1) : value;
  return digits.length >= 5 && digits.length <= 20 && isAsciiDigits(digits);
}

function isDtmfSequence(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (!char || !DTMF_CHARACTERS.has(char)) {
      return false;
    }
  }
  return true;
}

export function normalizeDialInNumber(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const compact = normalized.replace(/[()\s.-]/g, "");
  if (!isDialInNumber(compact)) {
    throw new Error("dialInNumber must be a phone number");
  }
  return compact;
}

export function normalizeDtmfSequence(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const compact = normalized.replace(/\s+/g, "");
  if (!isDtmfSequence(compact)) {
    throw new Error("dtmfSequence may only contain digits, *, #, comma, w, p");
  }
  return compact;
}

export function buildMeetDtmfSequence(params: {
  pin?: string;
  dtmfSequence?: string;
}): string | undefined {
  const explicit = normalizeDtmfSequence(params.dtmfSequence);
  if (explicit) {
    return explicit;
  }
  const pin = normalizeOptionalString(params.pin);
  if (!pin) {
    return undefined;
  }
  const compactPin = pin.replace(/\s+/g, "");
  const pinDigits = compactPin.endsWith("#") ? compactPin.slice(0, -1) : compactPin;
  if (!isAsciiDigits(pinDigits)) {
    throw new Error("pin may only contain digits and an optional trailing #");
  }
  return compactPin.endsWith("#") ? compactPin : `${compactPin}#`;
}
