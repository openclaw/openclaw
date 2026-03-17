import { randomUUID } from "node:crypto";
import { hasIrcControlChars, stripIrcControlChars } from "./control-chars.js";
const IRC_TARGET_PATTERN = /^[^\s:]+$/u;
function parseIrcLine(line) {
  const raw = line.replace(/[\r\n]+/g, "").trim();
  if (!raw) {
    return null;
  }
  let cursor = raw;
  let prefix;
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
  if (!command) {
    return null;
  }
  cursor = firstSpace === -1 ? "" : cursor.slice(firstSpace + 1);
  const params = [];
  let trailing;
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
    trailing
  };
}
function parseIrcPrefix(prefix) {
  if (!prefix) {
    return {};
  }
  const nickPart = prefix.match(/^([^!@]+)!([^@]+)@(.+)$/);
  if (nickPart) {
    return {
      nick: nickPart[1],
      user: nickPart[2],
      host: nickPart[3]
    };
  }
  const nickHostPart = prefix.match(/^([^@]+)@(.+)$/);
  if (nickHostPart) {
    return {
      nick: nickHostPart[1],
      host: nickHostPart[2]
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
function decodeLiteralEscapes(input) {
  return input.replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\t/g, "	").replace(/\\0/g, "\0").replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))).replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}
function sanitizeIrcOutboundText(text) {
  const decoded = decodeLiteralEscapes(text);
  return stripIrcControlChars(decoded.replace(/\r?\n/g, " ")).trim();
}
function sanitizeIrcTarget(raw) {
  const decoded = decodeLiteralEscapes(raw);
  if (!decoded) {
    throw new Error("IRC target is required");
  }
  if (decoded !== decoded.trim()) {
    throw new Error(`Invalid IRC target: ${raw}`);
  }
  if (hasIrcControlChars(decoded)) {
    throw new Error(`Invalid IRC target: ${raw}`);
  }
  if (!IRC_TARGET_PATTERN.test(decoded)) {
    throw new Error(`Invalid IRC target: ${raw}`);
  }
  return decoded;
}
function splitIrcText(text, maxChars = 350) {
  const cleaned = sanitizeIrcOutboundText(text);
  if (!cleaned) {
    return [];
  }
  if (cleaned.length <= maxChars) {
    return [cleaned];
  }
  const chunks = [];
  let remaining = cleaned;
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf(" ", maxChars);
    if (splitAt < Math.floor(maxChars * 0.5)) {
      splitAt = maxChars;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks.filter(Boolean);
}
function makeIrcMessageId() {
  return randomUUID();
}
export {
  makeIrcMessageId,
  parseIrcLine,
  parseIrcPrefix,
  sanitizeIrcOutboundText,
  sanitizeIrcTarget,
  splitIrcText
};
