// Terminal Core module implements note behavior.
import { AsyncLocalStorage } from "node:async_hooks";
import { visibleWidth } from "./ansi.js";
import { stylePromptTitle } from "./prompt-style.js";
import { normalizeLowercaseStringOrEmpty } from "./string.js";
import { isRich, theme } from "./theme.js";

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

/**
 * Returns true when a line exceeds maxWidth and at least one of the words on
 * that line is a copy-sensitive token (path, URL, file-like name).  Such lines
 * are allowed to overflow the note box rather than being re-wrapped, because
 * breaking them mid-token defeats the reason they are surfaced — the user needs
 * to copy-paste them unbroken.
 */
function hasCopySensitiveOverflow(line: string, maxWidth: number): boolean {
  if (visibleWidth(line) <= maxWidth) return false;
  const words = line.split(/\s+/);
  return words.some((w) => isCopySensitiveToken(w));
}

/**
 * Render a bordered note box directly, bypassing @clack/prompts' note() so that
 * OpenClaw owns the text-wrapping decisions end-to-end.  wrapNoteMessage already
 * produces correctly-wrapped lines (copy-sensitive tokens are kept intact and
 * allowed to overflow the wrap width).  clackNote would re-wrap them at the box
 * border, splitting paths mid-token.  Building the box ourselves eliminates that
 * second pass.
 *
 * Lines that contain copy-sensitive tokens and exceed the content area width are
 * allowed to overflow past the right border of the box.
 */
function renderNoteBox(
  message: string,
  title: string | undefined,
  columns: number,
  output: NodeJS.WriteStream,
) {
  const rich = isRich();
  const dim = (s: string) => (rich ? theme.muted(s) : s);
  const accent = (s: string) => (rich ? theme.accent(s) : s);

  const titleText = title ?? "";
  const titleWidth = visibleWidth(titleText);
  const contentLines = message.split("\n");

  const boxH = dim("─");
  const boxV = dim("│");
  const cornerTR = dim("╮");
  const cornerBL = dim("╰");
  const cornerBR = dim("╯");
  const step = accent("◇");

  const borderLeftWidth = 3; // "│  "
  const borderRightWidth = 3; // "  │"
  const borderOverhead = borderLeftWidth + borderRightWidth; // 6

  // Content area width: max of title and non-copy-sensitive lines.
  // Copy-sensitive overflow lines are allowed to exceed this.
  let contentWidth = Math.max(titleWidth, 40);
  for (const line of contentLines) {
    const w = visibleWidth(line);
    if (w > contentWidth && !hasCopySensitiveOverflow(line, columns - borderOverhead)) {
      contentWidth = w;
    }
  }
  contentWidth = Math.min(contentWidth, columns - borderOverhead);

  // Title line: ◇  Title ───╮
  const titleDashLen = Math.max(1, contentWidth - titleWidth + 1);
  output.write(`${step}  ${titleText} ${boxH.repeat(titleDashLen)}${cornerTR}\n`);

  // Content lines
  for (const line of contentLines) {
    const lineWidth = visibleWidth(line);
    if (lineWidth > contentWidth && hasCopySensitiveOverflow(line, contentWidth)) {
      // Copy-sensitive overflow: let the line extend past the box right border.
      output.write(`${boxV}  ${line}\n`);
    } else {
      const pad = Math.max(0, contentWidth - lineWidth);
      output.write(`${boxV}  ${line}${" ".repeat(pad)}  ${boxV}\n`);
    }
  }

  // Bottom line: ╰───╯
  output.write(`${cornerBL}${boxH.repeat(contentWidth + 4)}${cornerBR}\n`);
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
  const output = createNoteOutput(columns);
  renderNoteBox(wrapped, stylePromptTitle(title), columns, output);
}

export function withSuppressedNotes<T>(callback: () => T): T {
  return suppressNotesStorage.run(true, callback);
}
