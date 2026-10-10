import { hasIrcControlChars, stripIrcControlChars } from "./control-chars.js";

const IRC_TARGET_PATTERN = /^[^\s:]+$/u;

type ParsedIrcLine = {
  raw: string;
  prefix?: string;
  command: string;
  params: string[];
  trailing?: string;
};

type ParsedIrcPrefix = {
  nick?: string;
  user?: string;
  host?: string;
  server?: string;
};

export function parseIrcLine(line: string): ParsedIrcLine | null {
  const raw = line.replace(/[\r\n]+/g, "").trim();
  if (!raw) {
    return null;
  }

  let cursor = raw;
  let prefix: string | undefined;
  if (cursor.startsWith(":")) {
    const idx = cursor.indexOf(" ");
    if (idx <= 1) {
      return null;
    }
    prefix = cursor.slice(1, idx);
    cursor = cursor.slice(idx + 1).trimStart();
  }

  if (!cursor) {
    return null;
  }

  const firstSpace = cursor.indexOf(" ");
  const command = (firstSpace === -1 ? cursor : cursor.slice(0, firstSpace)).trim();
  cursor = firstSpace === -1 ? "" : cursor.slice(firstSpace + 1);
  const params: string[] = [];
  let trailing: string | undefined;

  while (cursor.length > 0) {
    cursor = cursor.trimStart();
    if (!cursor) {
      break;
    }
    if (cursor.startsWith(":")) {
      trailing = cursor.slice(1);
      break;
    }
    const spaceIdx = cursor.indexOf(" ");
    if (spaceIdx === -1) {
      params.push(cursor);
      break;
    }
    params.push(cursor.slice(0, spaceIdx));
    cursor = cursor.slice(spaceIdx + 1);
  }

  return {
    raw,
    prefix,
    command: command.toUpperCase(),
    params,
    trailing,
  };
}

export function parseIrcPrefix(prefix?: string): ParsedIrcPrefix {
  if (!prefix) {
    return {};
  }
  const nickPart = prefix.match(/^([^!@]+)!([^@]+)@(.+)$/);
  if (nickPart) {
    return {
      nick: nickPart[1],
      user: nickPart[2],
      host: nickPart[3],
    };
  }
  const nickHostPart = prefix.match(/^([^@]+)@(.+)$/);
  if (nickHostPart) {
    return {
      nick: nickHostPart[1],
      host: nickHostPart[2],
    };
  }
  if (prefix.includes("!")) {
    const [nick, user] = prefix.split("!", 2);
    return { nick, user };
  }
  if (prefix.includes(".")) {
    return { server: prefix };
  }
  return { nick: prefix };
}

// Only real CR/LF and control characters can break out of an IRC line. Literal
// backslash sequences such as "\n" or "C:\temp" are ordinary text and pass through.
export function sanitizeIrcOutboundText(text: string): string {
  return stripIrcControlChars(text.replace(/\r?\n/g, " ")).trim();
}

export function sanitizeIrcTarget(raw: string): string {
  if (!raw) {
    throw new Error("IRC target is required");
  }
  // Reject any surrounding whitespace instead of trimming it away.
  if (raw !== raw.trim() || hasIrcControlChars(raw) || !IRC_TARGET_PATTERN.test(raw)) {
    throw new Error(`Invalid IRC target: ${raw}`);
  }
  return raw;
}
