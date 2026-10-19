import os from "node:os";
import { lowercasePreservingWhitespace } from "@openclaw/normalization-core";
import {
  normalizeHomeDirValue,
  resolveEffectiveHomeDir,
} from "@openclaw/normalization-core/home-dir";

// Display-safe string helpers for shortening user home paths.

/** Resolve the display prefix that should replace the effective home path. */
function resolveHomeDisplayPrefix(): { home: string; prefix: string } | undefined {
  const home = resolveEffectiveHomeDir(process.env, os.homedir, {
    preserveUnresolvedTilde: true,
  });
  if (!home) {
    return undefined;
  }
  const explicitHome = normalizeHomeDirValue(process.env.OPENCLAW_HOME);
  return explicitHome ? { home, prefix: "$OPENCLAW_HOME" } : { home, prefix: "~" };
}

/** Find a case-insensitive Windows path without changing offsets in the original string. */
function indexOfWindowsPath(input: string, home: string, cursor: number): number {
  const foldedHome = lowercasePreservingWhitespace(home);
  // Match either Windows separator without folding the input and shifting Unicode offsets.
  const separatorOffset = home.indexOf("\\");
  const separators = /[\\/]/g;
  separators.lastIndex = cursor + separatorOffset;
  for (let match = separators.exec(input); match; match = separators.exec(input)) {
    const index = match.index - separatorOffset;
    if (index > input.length - home.length) {
      break;
    }
    // Keep URI schemes intact when a new slash alias resembles a drive or UNC home.
    if (
      input[index - 1] === ":" &&
      input.slice(index, index + home.length).includes("/") &&
      /[A-Za-z][A-Za-z0-9+.-]*:$/u.test(input.slice(0, index))
    ) {
      continue;
    }
    if (
      lowercasePreservingWhitespace(
        input.slice(index, index + home.length).replaceAll("/", "\\"),
      ) === foldedHome
    ) {
      return index;
    }
  }
  return -1;
}

/** Replace a whole-value home or child path without clipping sibling path prefixes. */
function replaceHomePath(input: string, display: { home: string; prefix: string }): string {
  let output = "";
  let cursor = 0;
  // terminal-core is standalone, so it keeps only its token-aware scan local;
  // app-level home selection and path rendering remain owned by core.
  while (cursor < input.length) {
    const index =
      process.platform === "win32"
        ? indexOfWindowsPath(input, display.home, cursor)
        : input.indexOf(display.home, cursor);
    if (index < 0) {
      return `${output}${input.slice(cursor)}`;
    }

    const before = input[index - 1];
    const homeEnd = index + display.home.length;
    const after = input[homeEnd];
    const startsToken = before === undefined || /[\s("'`:=[{,]/u.test(before);
    let punctuationEnd = homeEnd;
    while (punctuationEnd < input.length && /[)"'`:,;.\]}]/u.test(input.charAt(punctuationEnd))) {
      punctuationEnd += 1;
    }
    const punctuationEndsToken =
      punctuationEnd > homeEnd &&
      (punctuationEnd === input.length || /\s/u.test(input.charAt(punctuationEnd)));
    const endsTokenOrContinuesPath =
      after === undefined || after === "/" || after === "\\" || punctuationEndsToken;
    if (startsToken && endsTokenOrContinuesPath) {
      output += `${input.slice(cursor, index)}${display.prefix}`;
    } else {
      output += input.slice(cursor, index + display.home.length);
    }
    cursor = index + display.home.length;
  }

  return output;
}

/** Prepare one home snapshot for a synchronous render; new renders observe environment changes. */
export function createDisplayStringFormatter(): (input: string) => string {
  const display = resolveHomeDisplayPrefix();
  return (input) => (display ? replaceHomePath(input, display) : input);
}
