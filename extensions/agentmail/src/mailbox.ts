const MAX_FROM_LENGTH = 998;
const MAX_ADDRESS_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;
const MAX_DOMAIN_LENGTH = 253;
const LOCAL_PART_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u;
const DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const UNQUOTED_DISPLAY_SPECIALS_PATTERN = /[()[\]<>:;@\\]/u;

function hasControlOrBidiCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

export function normalizeMailbox(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function parseAsciiMailbox(value: string): string | null {
  if (!value || value.length > MAX_ADDRESS_LENGTH || hasControlOrBidiCharacter(value)) {
    return null;
  }

  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) {
    return null;
  }

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (
    local.length > MAX_LOCAL_LENGTH ||
    domain.length > MAX_DOMAIN_LENGTH ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !LOCAL_PART_PATTERN.test(local)
  ) {
    return null;
  }

  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL_PATTERN.test(label))) {
    return null;
  }

  return normalizeMailbox(`${local}@${domain}`);
}

function parseDisplayName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || hasControlOrBidiCharacter(trimmed)) {
    return null;
  }

  if (!trimmed.startsWith('"')) {
    return trimmed.includes('"') || UNQUOTED_DISPLAY_SPECIALS_PATTERN.test(trimmed)
      ? null
      : trimmed;
  }
  if (!trimmed.endsWith('"') || trimmed.length < 2) {
    return null;
  }

  let decoded = "";
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const character = trimmed.charAt(index);
    if (character === "\\") {
      index += 1;
      if (index >= trimmed.length - 1) {
        return null;
      }
      decoded += trimmed.charAt(index);
      continue;
    }
    if (character === '"') {
      return null;
    }
    decoded += character;
  }

  const name = decoded.trim();
  return name || null;
}

/**
 * AgentMail documents `from` as either an address or `Display Name <address>`.
 * Keep authorization deliberately narrower than general RFC mailbox syntax so
 * lists, groups, encoded forms, and ambiguous input fail closed.
 */
export function parseSingleFromMailbox(value: string): { address: string; name?: string } | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_FROM_LENGTH || hasControlOrBidiCharacter(trimmed)) {
    return null;
  }

  const open = trimmed.indexOf("<");
  const close = trimmed.indexOf(">");
  if (open === -1 && close === -1) {
    const address = parseAsciiMailbox(trimmed);
    return address ? { address } : null;
  }

  if (
    open < 0 ||
    close !== trimmed.length - 1 ||
    open !== trimmed.lastIndexOf("<") ||
    close !== trimmed.lastIndexOf(">") ||
    close <= open + 1
  ) {
    return null;
  }

  const address = parseAsciiMailbox(trimmed.slice(open + 1, close).trim());
  if (!address) {
    return null;
  }
  const rawName = trimmed.slice(0, open);
  if (!rawName.trim()) {
    return { address };
  }
  const name = parseDisplayName(rawName);
  return name ? { address, name } : null;
}

export function isAgentMailSenderAllowed(params: {
  policy: "allowlist" | "open" | "disabled";
  allowFrom: readonly string[];
  sender: string;
}): boolean {
  if (params.policy === "disabled") {
    return false;
  }
  const allowFrom = new Set(params.allowFrom.map(normalizeMailbox));
  if (params.policy === "open") {
    return allowFrom.has("*");
  }
  return allowFrom.has(normalizeMailbox(params.sender));
}
