/**
 * Detects `$<digit>` positional-parameter expansions that silently corrupt
 * agent-authored text passed through a shell.
 *
 * Agents routinely run commands like
 *   send-sms.sh --message "Rent is $900 per month"
 * Inside double quotes (or unquoted, or in an unquoted heredoc) the shell
 * expands `$9` -- an unset positional parameter at the top level of an exec
 * command -- to the empty string, so the recipient sees "Rent is 00 per
 * month". `$1,000` becomes `,000`, `$5 fee` becomes ` fee`.
 *
 * At the top level of a one-shot exec command positional parameters are
 * always empty, so such an expansion is never what the author meant. The
 * guard blocks the command before it runs and tells the model how to
 * re-issue it safely (single quotes, `\$`, or a quoted heredoc / file).
 *
 * The scanner is deliberately conservative: on any parse it does not fully
 * understand it fails open (returns undefined) rather than blocking.
 */

export type ShellDollarExpansionHazard = {
  /** The offending expansion as written, e.g. `$900` or `$1,000`. */
  token: string;
  /** Short excerpt of the surrounding text as authored. */
  excerpt: string;
  /** The same excerpt as the shell would actually deliver it. */
  expandedExcerpt: string;
};

type Finding = { index: number; source: string; token: string; digit: string };

const SHELL_BASENAMES = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const EXCERPT_RADIUS = 32;
const MAX_UNWRAP_DEPTH = 3;

class ParseAbort extends Error {}

/** A `$<digit>` followed by more digits, `,` or `.` reads as money (or `$10`, which is never `${10}`). */
function isMoneyLike(source: string, index: number): boolean {
  const after = source.slice(index + 2, index + 4);
  return /^[0-9]/u.test(after) || /^[,.][0-9]/u.test(after);
}

/**
 * Commands that define shell functions or set positional parameters can expand
 * `$1` (even `$1.00`) on purpose. The guard cannot infer intent there, so it
 * stays out of those commands entirely.
 */
function mayUsePositionalParameters(command: string): boolean {
  return (
    /(?:^|[\s;&|({])function\s+[A-Za-z_][\w-]*/u.test(command) ||
    /(?:^|[\s;&|({])[A-Za-z_][\w-]*\s*\(\s*\)\s*[{(]/u.test(command) ||
    /(?:^|[\s;&|({])set\s+(?:-[A-Za-z]+\s+)*--(?:\s|$)/u.test(command) ||
    /(?:^|[\s;&|({])(?:shift|getopts)(?:\s|;|$)/u.test(command)
  );
}

type Lexer = {
  src: string;
  pos: number;
  findings: Finding[];
  pendingHeredocs: Array<{ delimiter: string; expand: boolean; stripTabs: boolean }>;
};

function recordDollar(lx: Lexer, index: number): void {
  const digit = lx.src[index + 1];
  // `$0` expands to the shell or script name, never to an empty parameter; only
  // a money-shaped `$0.50` is corrupted text.
  if (digit === "0" && !isMoneyLike(lx.src, index)) {
    return;
  }
  if (digit !== undefined && /[0-9]/u.test(digit)) {
    let end = index + 2;
    while (end < lx.src.length && /[0-9,.]/u.test(lx.src[end] ?? "")) {
      end += 1;
    }
    // Trim trailing punctuation that is sentence text, not part of the amount.
    let token = lx.src.slice(index, end);
    token = token.replace(/[,.]+$/u, "");
    lx.findings.push({ index, source: lx.src, token, digit });
  }
}

/**
 * Handles a `$` at lx.pos in an expanding context (unquoted, double quotes or
 * unquoted heredoc body). Advances past whatever the `$` introduces.
 */
function consumeDollar(lx: Lexer, allowAnsiC: boolean): void {
  const next = lx.src[lx.pos + 1];
  if (next === undefined) {
    lx.pos += 1;
    return;
  }
  if (/[0-9]/u.test(next)) {
    recordDollar(lx, lx.pos);
    lx.pos += 2;
    return;
  }
  if (next === "{") {
    // `${...}` is explicit parameter expansion: skip to the matching brace.
    const close = lx.src.indexOf("}", lx.pos + 2);
    if (close < 0) {
      throw new ParseAbort("unterminated ${");
    }
    lx.pos = close + 1;
    return;
  }
  if (next === "(") {
    if (lx.src[lx.pos + 2] === "(") {
      // Arithmetic `$(( ... ))`: skip without inspecting.
      const close = lx.src.indexOf("))", lx.pos + 3);
      if (close < 0) {
        throw new ParseAbort("unterminated $((");
      }
      lx.pos = close + 2;
      return;
    }
    lx.pos += 2;
    scanCommandContext(lx, ")");
    return;
  }
  if (next === "'" && allowAnsiC) {
    // ANSI-C `$'...'`: contents are literal with respect to `$`.
    lx.pos += 2;
    while (lx.pos < lx.src.length) {
      const ch = lx.src[lx.pos];
      if (ch === "\\") {
        lx.pos += 2;
        continue;
      }
      if (ch === "'") {
        lx.pos += 1;
        return;
      }
      lx.pos += 1;
    }
    throw new ParseAbort("unterminated $'");
  }
  if (next === "$") {
    lx.pos += 2;
    return;
  }
  lx.pos += 1;
}

function scanBacktick(lx: Lexer): void {
  // Treat the backtick body as its own command context (no nesting support).
  const close = lx.src.indexOf("`", lx.pos + 1);
  if (close < 0) {
    throw new ParseAbort("unterminated backtick");
  }
  const inner: Lexer = {
    src: lx.src.slice(0, close),
    pos: lx.pos + 1,
    findings: lx.findings,
    pendingHeredocs: [],
  };
  scanCommandContext(inner, undefined);
  lx.pos = close + 1;
}

function scanDoubleQuoted(lx: Lexer): void {
  // lx.pos is just past the opening quote.
  while (lx.pos < lx.src.length) {
    const ch = lx.src[lx.pos];
    if (ch === "\\") {
      lx.pos += 2;
      continue;
    }
    if (ch === '"') {
      lx.pos += 1;
      return;
    }
    if (ch === "$") {
      consumeDollar(lx, false);
      continue;
    }
    if (ch === "`") {
      scanBacktick(lx);
      continue;
    }
    lx.pos += 1;
  }
  throw new ParseAbort("unterminated double quote");
}

function skipSingleQuoted(lx: Lexer): void {
  const close = lx.src.indexOf("'", lx.pos);
  if (close < 0) {
    throw new ParseAbort("unterminated single quote");
  }
  lx.pos = close + 1;
}

function readHeredocDelimiter(lx: Lexer): { delimiter: string; expand: boolean } {
  while (lx.src[lx.pos] === " " || lx.src[lx.pos] === "\t") {
    lx.pos += 1;
  }
  let delimiter = "";
  let expand = true;
  while (lx.pos < lx.src.length) {
    const ch = lx.src[lx.pos] ?? "";
    if (/[\s;&|<>()]/u.test(ch)) {
      break;
    }
    if (ch === "'" || ch === '"') {
      expand = false;
      const close = lx.src.indexOf(ch, lx.pos + 1);
      if (close < 0) {
        throw new ParseAbort("unterminated heredoc delimiter");
      }
      delimiter += lx.src.slice(lx.pos + 1, close);
      lx.pos = close + 1;
      continue;
    }
    if (ch === "\\") {
      expand = false;
      delimiter += lx.src[lx.pos + 1] ?? "";
      lx.pos += 2;
      continue;
    }
    delimiter += ch;
    lx.pos += 1;
  }
  if (!delimiter) {
    throw new ParseAbort("empty heredoc delimiter");
  }
  return { delimiter, expand };
}

/** Called at the newline that ends a line with pending heredocs; consumes their bodies. */
function consumeHeredocBodies(lx: Lexer): void {
  const pending = lx.pendingHeredocs.splice(0);
  for (const heredoc of pending) {
    let found = false;
    while (lx.pos <= lx.src.length) {
      const lineEnd = lx.src.indexOf("\n", lx.pos);
      const end = lineEnd < 0 ? lx.src.length : lineEnd;
      const line = lx.src.slice(lx.pos, end);
      const candidate = heredoc.stripTabs ? line.replace(/^\t+/u, "") : line;
      if (candidate === heredoc.delimiter) {
        lx.pos = lineEnd < 0 ? lx.src.length : lineEnd + 1;
        found = true;
        break;
      }
      if (heredoc.expand) {
        scanHeredocLine(lx, lx.pos, end);
      }
      if (lineEnd < 0) {
        lx.pos = lx.src.length;
        break;
      }
      lx.pos = lineEnd + 1;
    }
    if (!found) {
      // bash accepts EOF as the terminator (with a warning); keep the findings.
      return;
    }
  }
}

function scanHeredocLine(lx: Lexer, start: number, end: number): void {
  // An unquoted heredoc body expands `$`, `${...}`, `$(...)` and backticks but
  // treats quotes literally. Substitutions are command context with their own
  // quoting, so reuse the command scanner for them. Bounding the source at the
  // line end makes a substitution that spans lines fail open (ParseAbort).
  const inner: Lexer = {
    src: lx.src.slice(0, end),
    pos: start,
    findings: lx.findings,
    pendingHeredocs: [],
  };
  while (inner.pos < end) {
    const ch = inner.src[inner.pos];
    if (ch === "\\") {
      inner.pos += 2;
      continue;
    }
    if (ch === "`") {
      scanBacktick(inner);
      continue;
    }
    if (ch === "$") {
      consumeDollar(inner, false);
      continue;
    }
    inner.pos += 1;
  }
}

/**
 * Scans shell syntax in command context until `terminator` (for `$(...)`) or
 * end of input.
 */
function scanCommandContext(lx: Lexer, terminator: ")" | undefined): void {
  let depth = 0;
  let atWordStart = true;
  while (lx.pos < lx.src.length) {
    const ch = lx.src[lx.pos] ?? "";
    if (ch === "\\") {
      if (lx.src[lx.pos + 1] === "\n") {
        lx.pos += 2;
        continue;
      }
      lx.pos += 2;
      atWordStart = false;
      continue;
    }
    if (ch === "'") {
      lx.pos += 1;
      skipSingleQuoted(lx);
      atWordStart = false;
      continue;
    }
    if (ch === '"') {
      lx.pos += 1;
      scanDoubleQuoted(lx);
      atWordStart = false;
      continue;
    }
    if (ch === "$") {
      consumeDollar(lx, true);
      atWordStart = false;
      continue;
    }
    if (ch === "`") {
      scanBacktick(lx);
      atWordStart = false;
      continue;
    }
    if (ch === "#" && atWordStart) {
      const lineEnd = lx.src.indexOf("\n", lx.pos);
      lx.pos = lineEnd < 0 ? lx.src.length : lineEnd;
      continue;
    }
    if (ch === "<" && lx.src[lx.pos + 1] === "<") {
      if (lx.src[lx.pos + 2] === "<") {
        // Here-string `<<<word`: the word is scanned normally.
        lx.pos += 3;
        atWordStart = true;
        continue;
      }
      lx.pos += 2;
      let stripTabs = false;
      if (lx.src[lx.pos] === "-") {
        stripTabs = true;
        lx.pos += 1;
      }
      const { delimiter, expand } = readHeredocDelimiter(lx);
      lx.pendingHeredocs.push({ delimiter, expand, stripTabs });
      atWordStart = false;
      continue;
    }
    if (ch === "\n") {
      lx.pos += 1;
      atWordStart = true;
      if (lx.pendingHeredocs.length > 0) {
        consumeHeredocBodies(lx);
      }
      continue;
    }
    if (ch === "(") {
      depth += 1;
      lx.pos += 1;
      atWordStart = true;
      continue;
    }
    if (ch === ")") {
      if (terminator === ")" && depth === 0) {
        lx.pos += 1;
        return;
      }
      depth = Math.max(0, depth - 1);
      lx.pos += 1;
      atWordStart = true;
      continue;
    }
    atWordStart = /[\s;&|<>]/u.test(ch);
    lx.pos += 1;
  }
  if (terminator) {
    throw new ParseAbort("unterminated $(");
  }
}

/**
 * Splits a command into shell words, decoding quotes, for the narrow purpose
 * of recognizing `bash -lc '<script>'` wrappers. Returns undefined when the
 * command is not a single simple command.
 */
function splitSimpleCommandWords(command: string): string[] | undefined {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let i = 0;
  const src = command.trim();
  while (i < src.length) {
    const ch = src[i] ?? "";
    if (/\s/u.test(ch)) {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
      i += 1;
      continue;
    }
    if (/[;&|<>()`]/u.test(ch)) {
      return undefined;
    }
    inWord = true;
    if (ch === "'") {
      const close = src.indexOf("'", i + 1);
      if (close < 0) {
        return undefined;
      }
      current += src.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (ch === "$" && src[i + 1] === "'") {
      // ANSI-C quoted wrapper argument; decode the common escapes.
      let j = i + 2;
      let decoded = "";
      while (j < src.length && src[j] !== "'") {
        if (src[j] === "\\" && j + 1 < src.length) {
          const esc = src[j + 1] ?? "";
          decoded += esc === "n" ? "\n" : esc === "t" ? "\t" : esc;
          j += 2;
          continue;
        }
        decoded += src[j];
        j += 1;
      }
      if (j >= src.length) {
        return undefined;
      }
      current += decoded;
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let decoded = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && /["\\$`\n]/u.test(src[j + 1] ?? "")) {
          decoded += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === "$" || src[j] === "`") {
          // Expansions in the wrapper itself are scanned at the outer level.
          return undefined;
        }
        decoded += src[j];
        j += 1;
      }
      if (j >= src.length) {
        return undefined;
      }
      current += decoded;
      i = j + 1;
      continue;
    }
    if (ch === "\\") {
      current += src[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === "$") {
      return undefined;
    }
    current += ch;
    i += 1;
  }
  if (inWord) {
    words.push(current);
  }
  return words;
}

/**
 * Returns the script of `bash -lc '<script>'` / `sh -c "<script>"` when the
 * whole command is such a wrapper with no extra positional arguments.
 */
function unwrapShellDashC(command: string): string | undefined {
  const words = splitSimpleCommandWords(command);
  if (!words || words.length < 3) {
    return undefined;
  }
  let index = 0;
  if (words[0] === "env" || words[0] === "/usr/bin/env") {
    index += 1;
  }
  const shell = words[index]?.split("/").pop();
  if (!shell || !SHELL_BASENAMES.has(shell)) {
    return undefined;
  }
  index += 1;
  let sawC = false;
  while (index < words.length && words[index]?.startsWith("-")) {
    const flag = words[index] ?? "";
    if (/^-[a-z]*c[a-z]*$/u.test(flag)) {
      sawC = true;
      index += 1;
      break;
    }
    if (!/^-[a-z]+$/u.test(flag) && flag !== "--login") {
      return undefined;
    }
    index += 1;
  }
  if (!sawC || index !== words.length - 1) {
    // Extra args after the script set $0/$1...; the script may use them.
    return undefined;
  }
  return words[index];
}

function scanCommand(command: string): Finding[] {
  const lx: Lexer = { src: command, pos: 0, findings: [], pendingHeredocs: [] };
  scanCommandContext(lx, undefined);
  return lx.findings;
}

function buildExcerpt(finding: Finding): { excerpt: string; expandedExcerpt: string } {
  const { source, index, token } = finding;
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(source.length, index + token.length + EXCERPT_RADIUS);
  const prefix = (start > 0 ? "…" : "") + source.slice(start, index);
  const suffix = source.slice(index + token.length, end) + (end < source.length ? "…" : "");
  // `$9` expands to "" and the rest of the token stays literal.
  const expandedToken = finding.digit === "0" ? `bash${token.slice(2)}` : token.slice(2);
  const oneLine = (text: string) => text.replace(/\s+/gu, " ");
  return {
    excerpt: oneLine(`${prefix}${token}${suffix}`),
    expandedExcerpt: oneLine(`${prefix}${expandedToken}${suffix}`),
  };
}

/**
 * Finds the first `$<digit>` that the shell would expand to an (empty)
 * positional parameter. Returns undefined when the command is safe or could
 * not be parsed confidently.
 */
/** The guard is on unless OPENCLAW_EXEC_DOLLAR_GUARD=off. */
export function isShellDollarExpansionGuardEnabled(): boolean {
  return process.env.OPENCLAW_EXEC_DOLLAR_GUARD?.trim().toLowerCase() !== "off";
}

export function findShellDollarExpansionHazard(
  command: unknown,
): ShellDollarExpansionHazard | undefined {
  if (typeof command !== "string" || !command.includes("$")) {
    return undefined;
  }
  let script = command;
  let findings: Finding[] = [];
  try {
    for (let depth = 0; depth <= MAX_UNWRAP_DEPTH; depth += 1) {
      findings = scanCommand(script);
      if (findings.length > 0) {
        break;
      }
      const inner = unwrapShellDashC(script);
      if (inner === undefined || !inner.includes("$")) {
        return undefined;
      }
      script = inner;
    }
  } catch (error) {
    if (error instanceof ParseAbort) {
      return undefined;
    }
    throw error;
  }
  if (mayUsePositionalParameters(script)) {
    return undefined;
  }
  const first = findings[0];
  if (!first) {
    return undefined;
  }
  return { token: first.token, ...buildExcerpt(first) };
}

export function formatShellDollarExpansionHazard(hazard: ShellDollarExpansionHazard): string {
  return [
    `Blocked before execution: \`${hazard.token}\` is inside double quotes, an unquoted word, or an unquoted heredoc, so the shell expands \`$${hazard.token.charAt(1)}\` (an empty positional parameter) and the text is corrupted.`,
    `  as written:   ${hazard.excerpt}`,
    `  would become: ${hazard.expandedExcerpt}`,
    "Nothing was run. Re-issue the command with literal text protected from the shell:",
    "  - wrap the text in SINGLE quotes: --message 'Rent is $900/month' (write an apostrophe as '\\'' );",
    '  - or escape each dollar sign inside double quotes: "Rent is \\$900/month";',
    "  - or, for longer text, write it with a QUOTED heredoc and pass the file or stdin:",
    "      cat > /tmp/msg.txt <<'EOF'",
    "      Rent is $900/month.",
    "      EOF",
    "    then use the script's --*-file option (e.g. --message-file /tmp/msg.txt), or pass",
    '    "$(cat /tmp/msg.txt)" (command-substitution output is not expanded again).',
    "Do not retype the command with the amount removed or reworded.",
  ].join("\n");
}
