import type { PromptTemplate } from "./types.js";

function isWordCharacter(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}_]/u.test(char);
}

function isBoundary(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

function canOpenApostropheSpan(chars: string[], index: number): boolean {
  const next = chars[index + 1];
  return next !== undefined && next !== "'" && !/\s/.test(next);
}

function closesConcatSpan(chars: string[], index: number): boolean {
  return chars[index] === "'" && isBoundary(chars[index + 1]);
}

function nextConcatCloser(chars: string[], index: number): number {
  for (let j = index + 1; j < chars.length; j++) {
    if (closesConcatSpan(chars, j)) {
      return j;
    }
  }
  return -1;
}

function firstWhitespaceSpanCloser(chars: string[], index: number): number {
  let sawWhitespace = false;
  for (let j = index + 1; j < chars.length; j++) {
    if (/\s/.test(chars[j])) {
      sawWhitespace = true;
    } else if (sawWhitespace && closesConcatSpan(chars, j)) {
      return j;
    }
  }
  return -1;
}

const proseApostropheTails = new Set(["d", "ll", "m", "re", "s", "t", "ve"]);

function isProseSuffixApostrophe(chars: string[], index: number): boolean {
  if (!isWordCharacter(chars[index - 1]) || !isWordCharacter(chars[index + 1])) {
    return false;
  }
  let tail = "";
  for (let j = index + 1; isWordCharacter(chars[j]); j++) {
    tail += chars[j];
  }
  return isBoundary(chars[index + 1 + tail.length]) && proseApostropheTails.has(tail.toLowerCase());
}

function matchSingleQuoteSpan(chars: string[], index: number): number {
  if (chars[index + 1] === "'") {
    return index + 1;
  }
  if (!canOpenApostropheSpan(chars, index)) {
    return -1;
  }
  if (isWordCharacter(chars[index - 1])) {
    const closer = nextConcatCloser(chars, index);
    if (closer < 0) {
      return -1;
    }
    for (let k = index + 1; k < closer; k++) {
      if (chars[k] === "'" && nextConcatCloser(chars, k) >= 0) {
        return -1;
      }
    }
    return closer;
  }
  const whitespaceCloser = firstWhitespaceSpanCloser(chars, index);
  if (whitespaceCloser >= 0) {
    return whitespaceCloser;
  }
  for (let j = index + 1; j < chars.length; j++) {
    if (chars[j] === "'" && !isProseSuffixApostrophe(chars, j)) {
      return j;
    }
  }
  for (let j = index + 1; j < chars.length; j++) {
    if (chars[j] === "'") {
      return -1;
    }
  }
  return chars.length;
}

function nextDoubleQuote(chars: string[], index: number): number {
  for (let j = index + 1; j < chars.length; j++) {
    if (chars[j] === '"') {
      return j;
    }
  }
  return -1;
}

/** Parse an argument string using simple shell-style single and double quotes. */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  const chars = Array.from(argsString);
  let current = "";
  let inQuote: string | null = null;
  let closeAt = -1;
  let hasToken = false;

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (inQuote) {
      if (i === closeAt) {
        inQuote = null;
        closeAt = -1;
      } else {
        hasToken = true;
        current += char;
      }
    } else if (char === '"') {
      const matchingQuote = nextDoubleQuote(chars, i);
      inQuote = char;
      closeAt = matchingQuote >= 0 ? matchingQuote : chars.length;
      hasToken = true;
    } else if (char === "'") {
      const close = matchSingleQuoteSpan(chars, i);
      if (close >= 0) {
        inQuote = char;
        closeAt = close;
        hasToken = true;
      } else {
        hasToken = true;
        current += char;
      }
    } else if (/\s/.test(char)) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      hasToken = true;
      current += char;
    }
  }
  if (hasToken) {
    args.push(current);
  }
  return args;
}

function parseSafeNonNegativeInteger(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Substitute prompt template placeholders (`$1`, `$@`, `$ARGUMENTS`, `${@:N}`, `${@:N:L}`) with command arguments.
 *
 * Unsafe integer placeholders resolve to empty text instead of throwing, so malformed templates cannot abort prompt
 * loading or invocation.
 */
export function substituteArgs(content: string, args: string[]): string {
  let result = content;
  result = result.replace(/\$(\d+)/g, (_, num: string) => {
    const parsed = parseSafeNonNegativeInteger(num);
    if (parsed === undefined || parsed <= 0) {
      return "";
    }
    return args[parsed - 1] ?? "";
  });
  result = result.replace(
    /\$\{@:(\d+)(?::(\d+))?\}/g,
    (_, startStr: string, lengthStr?: string) => {
      const parsedStart = parseSafeNonNegativeInteger(startStr);
      if (parsedStart === undefined) {
        return "";
      }
      // Keep shell-style `${@:0:...}` compatibility: start 0 includes `$0` in shell, but
      // prompt templates have no command name, so it maps to the first provided argument.
      let start = parsedStart - 1;
      if (start < 0) {
        start = 0;
      }
      if (lengthStr) {
        const length = parseSafeNonNegativeInteger(lengthStr);
        if (length === undefined) {
          return "";
        }
        return args.slice(start, start + length).join(" ");
      }
      return args.slice(start).join(" ");
    },
  );
  const allArgs = args.join(" ");
  result = result.replace(/\$ARGUMENTS/g, allArgs);
  result = result.replace(/\$@/g, allArgs);
  return result;
}

/** Format a prompt template invocation using command-style argument substitution. */
export function formatPromptTemplateInvocation(
  template: PromptTemplate,
  args: string[] = [],
): string {
  return substituteArgs(template.content, args);
}
