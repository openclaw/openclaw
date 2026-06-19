// Terminal Core module implements note behavior.
import { AsyncLocalStorage } from "node:async_hooks";
import { note as clackNote } from "@clack/prompts";
import { visibleWidth } from "./ansi.js";
import { stylePromptTitle } from "./prompt-style.js";
import { normalizeLowercaseStringOrEmpty } from "./string.js";

const MIN_NOTE_COLUMNS = 80;
const URL_PREFIX_RE = /^(https?:\/\/|file:\/\/)/i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const FILE_LIKE_RE = /^[a-zA-Z0-9._-]+$/;
const NOTE_BOX_BORDER_WIDTH = 2;
const suppressNotesStorage = new AsyncLocalStorage<boolean>();

function isSuppressedByEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (!normalized) {
    return false;
  }
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

function splitCopySensitiveToken(token: string, maxLen: number): string[] {
  if (token.length <= maxLen) {
    return [token];
  }
  // For paths and URLs, try to split at path separators.
  const parts: string[] = [];
  let remaining = token;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }
    // Find the last path separator within maxLen boundary
    const slice = remaining.slice(0, maxLen);
    const lastSlash = Math.max(slice.lastIndexOf("/"), slice.lastIndexOf("\\"));
    const breakPoint = lastSlash > 0 ? lastSlash + 1 : maxLen;
    parts.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint);
  }
  return parts;
}

/**
 * Splits a copy-sensitive token (path, URL) at path-separator boundaries
 * so each segment fits within maxWidth. Used as a second pass after
 * wrapLine has already performed word-wrapping — only reaches lines
 * whose single copy-sensitive token still exceeds the clack note box
 * inner width.
 */
function splitOversizedCopySensitiveLine(line: string, maxWidth: number): string[] {
  const match = line.match(/^(\s*)(.*)$/);
  const indent = match?.[1] ?? "";
  const content = match?.[2] ?? "";
  const segments = splitCopySensitiveToken(content, maxWidth);
  // Each segment inherits the original indentation so the visual
  // alignment stays consistent inside the clack note box.
  return segments.map((seg) => indent + seg);
}

function splitLongWord(word: string, maxLen: number): string[] {
  if (maxLen <= 0) {
    return [word];
  }
  const chars = Array.from(word);
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i += maxLen) {
    parts.push(chars.slice(i, i + maxLen).join(""));
  }
  return parts.length > 0 ? parts : [word];
}

function isCopySensitiveToken(word: string): boolean {
  if (!word) {
    return false;
  }
  if (URL_PREFIX_RE.test(word)) {
    return true;
  }
  if (
    word.startsWith("/") ||
    word.startsWith("~/") ||
    word.startsWith("./") ||
    word.startsWith("../")
  ) {
    return true;
  }
  if (WINDOWS_DRIVE_RE.test(word) || word.startsWith("\\\\")) {
    return true;
  }
  if (word.includes("/") || word.includes("\\")) {
    return true;
  }
  // Preserve common file-like tokens (for example administrators_authorized_keys).
  return word.includes("_") && FILE_LIKE_RE.test(word);
}

function pushWrappedWordSegments(params: {
  word: string;
  available: number;
  firstPrefix: string;
  continuationPrefix: string;
  lines: string[];
}) {
  const parts = splitLongWord(params.word, params.available);
  const first = parts.shift() ?? "";
  params.lines.push(params.firstPrefix + first);
  for (const part of parts) {
    params.lines.push(params.continuationPrefix + part);
  }
}

function wrapLine(line: string, maxWidth: number): string[] {
  if (line.trim().length === 0) {
    return [line];
  }
  const match = line.match(/^(\s*)([-*\u2022]\s+)?(.*)$/);
  const indent = match?.[1] ?? "";
  const bullet = match?.[2] ?? "";
  const content = match?.[3] ?? "";
  const firstPrefix = `${indent}${bullet}`;
  const nextPrefix = `${indent}${bullet ? " ".repeat(bullet.length) : ""}`;
  const firstWidth = Math.max(10, maxWidth - visibleWidth(firstPrefix));
  const nextWidth = Math.max(10, maxWidth - visibleWidth(nextPrefix));

  const words = content.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  let prefix = firstPrefix;
  let available = firstWidth;

  for (const word of words) {
    if (!current) {
      if (visibleWidth(word) > available) {
        if (isCopySensitiveToken(word)) {
          current = word;
          continue;
        }
        pushWrappedWordSegments({
          word,
          available,
          firstPrefix: prefix,
          continuationPrefix: nextPrefix,
          lines,
        });
        prefix = nextPrefix;
        available = nextWidth;
        continue;
      }
      current = word;
      continue;
    }

    const candidate = `${current} ${word}`;
    if (visibleWidth(candidate) <= available) {
      current = candidate;
      continue;
    }

    lines.push(prefix + current);
    prefix = nextPrefix;
    available = nextWidth;

    if (visibleWidth(word) > available) {
      if (isCopySensitiveToken(word)) {
        current = word;
        continue;
      }
      pushWrappedWordSegments({
        word,
        available,
        firstPrefix: prefix,
        continuationPrefix: prefix,
        lines,
      });
      current = "";
      continue;
    }
    current = word;
  }

  if (current || words.length === 0) {
    lines.push(prefix + current);
  }

  return lines;
}

function coerceNoteMessage(message: unknown): string {
  if (typeof message === "string") {
    return message;
  }
  if (message == null) {
    return "";
  }
  if (typeof message === "number" || typeof message === "boolean" || typeof message === "bigint") {
    return String(message);
  }
  if (message instanceof Error) {
    return message.message ? `${message.name}: ${message.message}` : message.name;
  }
  return "";
}

export function wrapNoteMessage(
  message: unknown,
  options: { maxWidth?: number; columns?: number } = {},
): string {
  const text = coerceNoteMessage(message);
  const columns = options.columns ?? resolveNoteColumns(process.stdout.columns);
  const maxWidth = options.maxWidth ?? Math.max(40, Math.min(88, columns - 10));
  const boxInnerWidth = columns - NOTE_BOX_BORDER_WIDTH;
  return text
    .split("\n")
    .flatMap((line) => wrapLine(line, maxWidth))
    .flatMap((line) => {
      if (visibleWidth(line) <= boxInnerWidth) {
        return [line];
      }
      // After the first-pass word wrap, any remaining oversized line must
      // contain a copy-sensitive token that overflowed maxWidth.  Split it
      // at path-separator boundaries so it renders within clack's box.
      return splitOversizedCopySensitiveLine(line, boxInnerWidth);
    })
    .join("\n");
}

export function resolveNoteColumns(columns: number | undefined): number {
  if (!Number.isFinite(columns) || !columns || columns < MIN_NOTE_COLUMNS) {
    return MIN_NOTE_COLUMNS;
  }
  return columns;
}

function createNoteOutput(columns: number): NodeJS.WriteStream {
  if (process.stdout.columns === columns) {
    return process.stdout;
  }
  const output = Object.create(process.stdout) as NodeJS.WriteStream;
  Object.defineProperty(output, "columns", {
    value: columns,
    configurable: true,
  });
  output.write = process.stdout.write.bind(process.stdout);
  return output;
}

export function note(message: unknown, title?: string) {
  if (
    suppressNotesStorage.getStore() === true ||
    isSuppressedByEnv(process.env.OPENCLAW_SUPPRESS_NOTES)
  ) {
    return;
  }
  const columns = resolveNoteColumns(process.stdout.columns);
  clackNote(wrapNoteMessage(message, { columns }), stylePromptTitle(title), {
    output: createNoteOutput(columns),
    format: (line) => line,
  });
}

export function withSuppressedNotes<T>(callback: () => T): T {
  return suppressNotesStorage.run(true, callback);
}
