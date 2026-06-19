// Terminal Core module implements note behavior.
import { AsyncLocalStorage } from "node:async_hooks";
import { styleText } from "node:util";
import { visibleWidth } from "./ansi.js";
import { stylePromptTitle } from "./prompt-style.js";
import { normalizeLowercaseStringOrEmpty } from "./string.js";

const MIN_NOTE_COLUMNS = 80;
const URL_PREFIX_RE = /^(https?:\/\/|file:\/\/)/i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const FILE_LIKE_RE = /^[a-zA-Z0-9._-]+$/;
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
  return text
    .split("\n")
    .flatMap((line) => wrapLine(line, maxWidth))
    .join("\n");
}

export function resolveNoteColumns(columns: number | undefined): number {
  if (!Number.isFinite(columns) || !columns || columns < MIN_NOTE_COLUMNS) {
    return MIN_NOTE_COLUMNS;
  }
  return columns;
}

function renderBoxContent(message: string, title: string | undefined): void {
  const columns = resolveNoteColumns(process.stdout.columns);
  const contentWidth = Math.max(40, Math.min(88, columns - 10));

  const titleStr = title ?? "";
  const titleLen = visibleWidth(titleStr);
  const V = "│";
  const H = "─";

  // Guide prefix — matches @clack/prompts note withGuide default
  process.stdout.write(`${styleText("gray", V)}\n`);

  // ── top border: ◇  title ────────────╮
  const topDashes = Math.max(1, contentWidth - titleLen - 4);
  process.stdout.write(
    `${styleText("green", "◇")}  ${styleText("reset", titleStr)} ${styleText("gray", H.repeat(topDashes) + "╮")}\n`,
  );

  // Empty separator line
  const emptyLine = `${styleText("gray", V)}${" ".repeat(contentWidth + 2)}${styleText("gray", V)}`;
  process.stdout.write(emptyLine + "\n");

  // Content lines
  const lines = message.split("\n");
  for (const line of lines) {
    const lineWidth = visibleWidth(line);
    if (lineWidth <= contentWidth) {
      const padRight = contentWidth - lineWidth;
      process.stdout.write(
        `${styleText("gray", V)}  ${line}${" ".repeat(padRight)}  ${styleText("gray", V)}\n`,
      );
    } else {
      // Copy-sensitive overflow — let path overflow right edge
      process.stdout.write(`${styleText("gray", V)}  ${line}\n`);
    }
  }

  // Empty separator line
  process.stdout.write(emptyLine + "\n");

  // ── bottom border: ├──────────────────╯
  process.stdout.write(
    `${styleText("gray", "├")}${styleText("gray", H.repeat(contentWidth + 2))}${styleText("gray", "╯")}\n`,
  );
}

export function note(message: unknown, title?: string) {
  if (
    suppressNotesStorage.getStore() === true ||
    isSuppressedByEnv(process.env.OPENCLAW_SUPPRESS_NOTES)
  ) {
    return;
  }
  const columns = resolveNoteColumns(process.stdout.columns);
  const wrapped = wrapNoteMessage(message, { columns });
  renderBoxContent(wrapped, stylePromptTitle(title));
}

export function withSuppressedNotes<T>(callback: () => T): T {
  return suppressNotesStorage.run(true, callback);
}
