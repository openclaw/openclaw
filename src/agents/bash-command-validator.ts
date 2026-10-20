/**
 * Shared shell-command validation for model-facing bash/exec tools.
 */

const LEADING_TOOL_HISTORY_PREFIX_RE =
  /^\s*(?:`+|[\u{2192}\u{25B6}\u{26A0}\u{2705}\u{274C}\u{1F6E0}\u{1F4CC}\u{1F539}\u{1F53A}\u{1F53B}\u{1F4A1}\u{1F525}\u{1F680}\u{FE0F}\u{200D}]+\s*)+/u;
const LEADING_FAILURE_LABEL_RE =
  /^\s*(?:(?:bash|exec|shell)\s+failed|(?:bash|exec|shell)\s+error|error)\s*:\s*/iu;
const UNSUPPORTED_SEARCH_COMMAND_RE = /^\s*search(?:\s|$)/u;
const LEADING_COMMAND_LABEL_RE = /^\s*(?:command|cmd)\s*:/iu;
const NATURAL_LANGUAGE_WRAPPER_RE =
  /^\s*(?:run\s+(?:git|npm|pnpm|yarn|bun|node|python(?:3)?|ruby|php|sed|openclaw)|find files|list files|show (?:first|last|lines?)|view lines?|print (?:line|lines|text)|check git|view git|show git|list git|switch git|create git|pull git|push git|fetch git|merge git|rebase git|stage git|restore git|reset git|stash git)\b/iu;
const PATTERN_IN_PATH_WRAPPER_RE =
  /^\s*(?:check(?:\s+whether)?|inspect|look\s+for|scan|grep\s+for|match|show(?:\s+(?:matches?|occurrences?))?|print(?:\s+(?:matches?|occurrences?))?)\s+.+\b(?:in|inside|within|under)\b\s+(?:~\/|\/|\.{1,2}\/|[A-Za-z]:[\\/])/iu;
const TRAILING_LOCATION_NOTE_RE =
  /(?:^|[ \t;|&])(?:\([^()]*\bin\s+(?:~\/|\/|[A-Za-z]:[\\/])[^()]*\))\s*$/u;
const PYTHON_PSEUDO_SCRIPT_RE =
  /^\s*python3\s+(?:inline|script|command|description|example|analysis)(?:\s|$)/iu;

const UNSUPPORTED_SEARCH_COMMAND_MESSAGE =
  'Unsupported bash command "search". Use rg, grep, find, or an OpenClaw tool instead.';
const LEADING_COMMAND_LABEL_MESSAGE =
  "Shell command must not include prose labels like `Command:` or `cmd:`. Pass only the literal executable command.";
const NATURAL_LANGUAGE_WRAPPER_MESSAGE =
  "Shell command must start with the real executable, not a prose wrapper like `run git ...` or `find files ...`.";
const PATTERN_IN_PATH_WRAPPER_MESSAGE =
  "Shell command must use a real executable like `rg`, `grep`, `find`, or `sed`, not a prose search wrapper like `inspect ... in /path`.";
const TRAILING_LOCATION_NOTE_MESSAGE =
  "Shell command must be a literal executable command only. Move location notes like `(in /path)` into `workdir`/`cwd`, not the command string.";
const UNQUOTED_PATH_METACHAR_MESSAGE =
  "Shell command contains an unquoted path with shell-special characters like `(` or `[`. Quote the path or escape it before execution.";
const PYTHON_PSEUDO_SCRIPT_MESSAGE =
  "Shell command must pass executable Python via `python3 -c`, `python3 -m`, or a script path; prose such as `python3 inline script` is not executable.";

type ValidationToken = {
  raw: string;
  text: string;
  quotedOrEscaped: boolean;
};

function unwrapWholeInlineCodeSpan(command: string): string {
  const trimmed = command.trim();
  const wrapped = trimmed.match(/^(`{1,3})([\s\S]*?)\1$/u);
  return wrapped?.[2] !== undefined ? wrapped[2].trim() : trimmed;
}

function normalizeCommandForValidation(command: string): string {
  let normalized = unwrapWholeInlineCodeSpan(command);
  let changed = true;
  while (changed) {
    changed = false;
    const withoutHistoryPrefix = normalized.replace(LEADING_TOOL_HISTORY_PREFIX_RE, "");
    if (withoutHistoryPrefix !== normalized) {
      normalized = withoutHistoryPrefix.trimStart();
      changed = true;
    }
    const withoutFailureLabel = normalized.replace(LEADING_FAILURE_LABEL_RE, "");
    if (withoutFailureLabel !== normalized) {
      normalized = withoutFailureLabel.trimStart();
      changed = true;
    }
  }
  return normalized;
}

function tokenizeCommandForValidation(command: string): ValidationToken[] | null {
  const tokens: ValidationToken[] = [];
  let raw = "";
  let text = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let quotedOrEscaped = false;
  // Open shell grouping parens: `$(`, `<(`, `>(`, `(subshell)`, `$((`, `arr=(`.
  // Their parens are syntax, not part of a neighbouring path token.
  let groupDepth = 0;

  const pushToken = () => {
    if (!raw) {
      return;
    }
    tokens.push({ raw, text, quotedOrEscaped });
    raw = "";
    text = "";
    quotedOrEscaped = false;
  };

  for (const char of command) {
    if (!escaped && !quote) {
      if (char === "(" && (raw === "" || /[$<>=;|&]$/u.test(raw))) {
        pushToken();
        groupDepth += 1;
        continue;
      }
      if (char === ")" && groupDepth > 0) {
        pushToken();
        groupDepth -= 1;
        continue;
      }
    }
    if (escaped) {
      raw += `\\${char}`;
      text += char;
      escaped = false;
      quotedOrEscaped = true;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      raw += char;
      if (char === quote) {
        quote = undefined;
      } else {
        text += char;
      }
      quotedOrEscaped = true;
      continue;
    }

    if (char === "'" || char === '"') {
      raw += char;
      quote = char;
      quotedOrEscaped = true;
      continue;
    }

    if (/\s/u.test(char)) {
      pushToken();
      continue;
    }

    raw += char;
    text += char;
  }

  if (escaped || quote) {
    return null;
  }

  pushToken();
  return tokens;
}

function isPathLikeToken(token: string): boolean {
  return (
    token.includes("/") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/u.test(token)
  );
}

function hasUnquotedPathMetachar(raw: string): boolean {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let inParamExpansion = false;
  let previous = "";

  for (const char of raw) {
    const prior = previous;
    previous = char;
    // `${VAR}` braces are parameter expansion, not literal path characters.
    if (inParamExpansion) {
      if (char === "}") {
        inParamExpansion = false;
      }
      continue;
    }
    if (!escaped && !quote && char === "{" && prior === "$") {
      inParamExpansion = true;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (
      char === "(" ||
      char === ")" ||
      char === "[" ||
      char === "]" ||
      char === "{" ||
      char === "}"
    ) {
      return true;
    }
  }

  return false;
}

function containsUnsafeUnquotedPathToken(command: string): boolean {
  const tokens = tokenizeCommandForValidation(command);
  if (!tokens || tokens.length <= 1) {
    return false;
  }

  return tokens
    .slice(1)
    .some(
      (token) =>
        !token.quotedOrEscaped && isPathLikeToken(token.text) && hasUnquotedPathMetachar(token.raw),
    );
}

export function validateShellCommand(command: unknown): string | undefined {
  if (typeof command !== "string") {
    return undefined;
  }
  const normalized = normalizeCommandForValidation(command);
  if (
    UNSUPPORTED_SEARCH_COMMAND_RE.test(command) ||
    UNSUPPORTED_SEARCH_COMMAND_RE.test(normalized)
  ) {
    return UNSUPPORTED_SEARCH_COMMAND_MESSAGE;
  }
  if (LEADING_COMMAND_LABEL_RE.test(command) || LEADING_COMMAND_LABEL_RE.test(normalized)) {
    return LEADING_COMMAND_LABEL_MESSAGE;
  }
  if (NATURAL_LANGUAGE_WRAPPER_RE.test(command) || NATURAL_LANGUAGE_WRAPPER_RE.test(normalized)) {
    return NATURAL_LANGUAGE_WRAPPER_MESSAGE;
  }
  if (PATTERN_IN_PATH_WRAPPER_RE.test(command) || PATTERN_IN_PATH_WRAPPER_RE.test(normalized)) {
    return PATTERN_IN_PATH_WRAPPER_MESSAGE;
  }
  if (TRAILING_LOCATION_NOTE_RE.test(command) || TRAILING_LOCATION_NOTE_RE.test(normalized)) {
    return TRAILING_LOCATION_NOTE_MESSAGE;
  }
  if (PYTHON_PSEUDO_SCRIPT_RE.test(command) || PYTHON_PSEUDO_SCRIPT_RE.test(normalized)) {
    return PYTHON_PSEUDO_SCRIPT_MESSAGE;
  }
  if (containsUnsafeUnquotedPathToken(normalized)) {
    return UNQUOTED_PATH_METACHAR_MESSAGE;
  }
  return undefined;
}
