/** Shared remote-shell quoting, workdir validation, and directory contracts. */
export function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Build a remote shell command from literal argv entries. */
export function buildRemoteCommand(argv: string[]): string {
  return argv.map((entry) => shellEscape(entry)).join(" ");
}

type ExecCommandQuoteState = "plain" | "single" | "double";

type ExecCommandFrame = {
  kind: "root" | "command-substitution" | "arithmetic" | "backtick";
  quote: ExecCommandQuoteState;
  escaping: boolean;
  parenDepth: number;
};

type HeredocMarker = {
  delimiter: string;
  stripLeadingTabs: boolean;
};

type PendingHeredoc = HeredocMarker & {
  frameDepth: number;
};

function assertValidExecRemoteCommand(command: string): void {
  // The SSH backend wraps model-provided shell text in `/bin/sh -c`. This parser
  // catches unbalanced syntax and unresolved placeholders before quoting it.
  const frames: ExecCommandFrame[] = [
    { kind: "root", quote: "plain", escaping: false, parenDepth: 0 },
  ];
  const pendingHeredocs: PendingHeredoc[] = [];

  for (let index = 0; index < command.length; index += 1) {
    const frame = frames.at(-1);
    if (!frame) {
      throw new Error("Malformed SSH/OpenShell exec command: parser state underflow.");
    }
    const char = command.charAt(index);

    if (frame.escaping) {
      frame.escaping = false;
      continue;
    }

    if (frame.quote === "single") {
      if (char === "'") {
        frame.quote = "plain";
      }
      continue;
    }

    if (char === "\\") {
      frame.escaping = true;
      continue;
    }

    if (frame.quote === "double") {
      if (char === '"') {
        frame.quote = "plain";
        continue;
      }
      if (char === "`") {
        frames.push(createExecCommandFrame("backtick"));
        continue;
      }
      if (char === "$" && command[index + 1] === "(" && command[index + 2] === "(") {
        frames.push(createExecCommandFrame("arithmetic", 2));
        index += 2;
        continue;
      }
      if (char === "$" && command[index + 1] === "(") {
        frames.push(createExecCommandFrame("command-substitution", 1));
        index += 1;
      }
      continue;
    }

    if (frame.kind === "arithmetic") {
      if (char === "(") {
        frame.parenDepth += 1;
        continue;
      }
      if (char === ")") {
        frame.parenDepth -= 1;
        if (frame.parenDepth === 0) {
          frames.pop();
        }
      }
      continue;
    }

    if (char === "\n") {
      const frameHeredocs = pendingHeredocs.filter(
        (pending) => pending.frameDepth === frames.length,
      );
      if (frameHeredocs.length > 0) {
        // Here-doc bodies are opaque shell payloads; skip them so placeholder
        // and quote checks only inspect executable syntax.
        index = skipHeredocBodies(command, index + 1, frameHeredocs) - 1;
        for (const pending of frameHeredocs) {
          pendingHeredocs.splice(pendingHeredocs.indexOf(pending), 1);
        }
        continue;
      }
    }

    if (frame.kind === "backtick" && char === "`") {
      frames.pop();
      continue;
    }
    if (char === "'") {
      frame.quote = "single";
      continue;
    }
    if (char === '"') {
      frame.quote = "double";
      continue;
    }
    if (char === "`") {
      frames.push(createExecCommandFrame("backtick"));
      continue;
    }
    if (char === "$" && command[index + 1] === "(" && command[index + 2] === "(") {
      frames.push(createExecCommandFrame("arithmetic", 2));
      index += 2;
      continue;
    }
    if (char === "$" && command[index + 1] === "(") {
      frames.push(createExecCommandFrame("command-substitution", 1));
      index += 1;
      continue;
    }
    if (char === "#" && isShellCommentStart(command, index)) {
      index = skipShellComment(command, index) - 1;
      continue;
    }
    if (char === "<") {
      const heredoc = readHeredoc(command, index);
      if (heredoc) {
        pendingHeredocs.push({
          ...heredoc.pending,
          frameDepth: frames.length,
        });
        index = heredoc.endIndex - 1;
        continue;
      }
      const placeholder = readPlaceholderToken(command, index);
      if (placeholder) {
        throw new Error(
          `Malformed SSH/OpenShell exec command: unresolved placeholder token ${placeholder}.`,
        );
      }
    }
    if (frame.kind === "command-substitution") {
      if (char === "(") {
        frame.parenDepth += 1;
        continue;
      }
      if (char === ")") {
        frame.parenDepth -= 1;
        if (frame.parenDepth === 0) {
          frames.pop();
        }
      }
    }
  }

  const openFrame = frames.at(-1);
  if (openFrame?.escaping) {
    throw new Error("Malformed SSH/OpenShell exec command: trailing backslash escape.");
  }
  if (pendingHeredocs.length > 0) {
    const pending = pendingHeredocs.at(0);
    if (!pending) {
      throw new Error("Malformed SSH/OpenShell exec command: parser state underflow.");
    }
    throw new Error(
      `Malformed SSH/OpenShell exec command: unterminated here-doc ${pending.delimiter}.`,
    );
  }
  for (const frame of frames.toReversed()) {
    if (frame.quote === "single") {
      throw new Error("Malformed SSH/OpenShell exec command: unclosed single quote.");
    }
    if (frame.quote === "double") {
      throw new Error("Malformed SSH/OpenShell exec command: unclosed double quote.");
    }
    if (frame.kind === "backtick") {
      throw new Error(
        "Malformed SSH/OpenShell exec command: unterminated backtick command substitution.",
      );
    }
    if (frame.kind === "command-substitution") {
      throw new Error("Malformed SSH/OpenShell exec command: unterminated command substitution.");
    }
    if (frame.kind === "arithmetic") {
      throw new Error("Malformed SSH/OpenShell exec command: unterminated arithmetic expansion.");
    }
  }
}

/** Build the wrapped remote `/bin/sh -c` command for sandbox exec. */
export function buildExecRemoteCommand(params: {
  command: string;
  workdir?: string;
  env: Record<string, string>;
}): string {
  if (Object.keys(params.env).length > 0) {
    throw new Error(
      "SSH sandbox environment requires secure script staging; use prepareSshSandboxExec.",
    );
  }
  const body = params.workdir
    ? `cd ${shellEscape(params.workdir)} && ${params.command}`
    : params.command;
  return buildRemoteCommand(["/bin/sh", "-c", body]);
}

/** Validate and build a remote exec command for untrusted model input. */
export function buildValidatedExecRemoteCommand(params: {
  command: string;
  workdir?: string;
  env: Record<string, string>;
}): string {
  assertValidExecRemoteCommand(params.command);
  return buildExecRemoteCommand(params);
}

const VALIDATE_REMOTE_WORKDIR_SCRIPT = [
  "set -e",
  'target="$1"',
  'root="$2"',
  'case "$target" in /*) ;; *) echo "remote directory must be absolute: $target" >&2; exit 1 ;; esac',
  'case "$root" in /*) ;; *) echo "remote root must be absolute: $root" >&2; exit 1 ;; esac',
  'target="${target%/}"',
  'root="${root%/}"',
  '[ -n "$target" ] || target="/"',
  '[ -n "$root" ] || root="/"',
  'if [ "$root" != "/" ]; then',
  '  case "$target/" in "$root"/*|"$root/") ;; *) echo "remote directory must stay under root: $target" >&2; exit 1 ;; esac',
  "fi",
  'for path_to_check in "$target" "$root"; do',
  '  relative="${path_to_check#/}"',
  '  while [ -n "$relative" ]; do',
  '    part="${relative%%/*}"',
  '    if [ "$part" = "$relative" ]; then relative=""; else relative="${relative#*/}"; fi',
  '    [ -n "$part" ] || continue',
  '    case "$part" in "."|"..") echo "unsafe remote directory component: $part" >&2; exit 1 ;; esac',
  "  done",
  "done",
  'if [ -L "$root" ]; then echo "unsafe remote root symlink: $root" >&2; exit 1; fi',
  'if [ ! -d "$root" ]; then echo "remote root not found: $root" >&2; exit 1; fi',
  'canonical_root="$(cd "$root" && pwd -P)"',
  'relative="${target#"$root"}"',
  'relative="${relative#/}"',
  'current="$canonical_root"',
  'while [ -n "$relative" ]; do',
  '  part="${relative%%/*}"',
  '  if [ "$part" = "$relative" ]; then relative=""; else relative="${relative#*/}"; fi',
  '  [ -n "$part" ] || continue',
  '  if [ "$current" = "/" ]; then next="/$part"; else next="$current/$part"; fi',
  '  if [ -L "$next" ]; then echo "unsafe remote directory symlink: $next" >&2; exit 1; fi',
  '  if [ ! -d "$next" ]; then echo "remote directory not found: $next" >&2; exit 1; fi',
  '  current="$next"',
  "done",
  'printf "%s\\n" "$current"',
].join("\n");

export function buildRemoteWorkdirValidationCommand(params: {
  workdir: string;
  root: string;
}): string {
  return buildRemoteCommand([
    "/bin/sh",
    "-c",
    VALIDATE_REMOTE_WORKDIR_SCRIPT,
    "openclaw-validate-workdir",
    params.workdir,
    params.root,
  ]);
}

function createExecCommandFrame(kind: ExecCommandFrame["kind"], parenDepth = 0): ExecCommandFrame {
  return { kind, quote: "plain", escaping: false, parenDepth };
}

function readPlaceholderToken(command: string, index: number): string | null {
  const match = /^<[A-Za-z][A-Za-z0-9_-]*>/.exec(command.slice(index));
  if (!match) {
    return null;
  }
  if (command[index - 1] === "=") {
    return match[0];
  }
  if (isLikelyGeneratedWorkflowPlaceholder(command, index)) {
    return match[0];
  }
  const next = command[index + match[0].length];
  if (next === undefined || /[\r\n;&|)]/.test(next)) {
    return match[0];
  }
  if (next === " " || next === "\t") {
    return hasRedirectionTargetAfter(command, index + match[0].length) ? null : match[0];
  }
  return null;
}

function hasRedirectionTargetAfter(command: string, index: number): boolean {
  let cursor = index;
  while (command.charAt(cursor) === " " || command.charAt(cursor) === "\t") {
    cursor += 1;
  }
  const next = command.charAt(cursor);
  return next !== "" && !/[;&|()<>\r\n]/.test(next);
}

function isLikelyGeneratedWorkflowPlaceholder(command: string, index: number): boolean {
  const prefix = command.slice(0, index);
  const segmentStart =
    Math.max(
      prefix.lastIndexOf("\n"),
      prefix.lastIndexOf(";"),
      prefix.lastIndexOf("&"),
      prefix.lastIndexOf("|"),
      prefix.lastIndexOf("("),
      prefix.lastIndexOf("`"),
    ) + 1;
  const currentCommand = prefix.slice(segmentStart).trim();
  return /^workflow(?:\s+[A-Za-z0-9._/-]+)*$/.test(currentCommand);
}

function readHeredoc(
  command: string,
  index: number,
): { pending: HeredocMarker; endIndex: number } | null {
  if (command[index + 1] !== "<" || command[index + 2] === "<") {
    return null;
  }
  let cursor = index + 2;
  const stripLeadingTabs = command[cursor] === "-";
  if (stripLeadingTabs) {
    cursor += 1;
  }
  while (command[cursor] === " " || command[cursor] === "\t") {
    cursor += 1;
  }
  const delimiter = readHeredocDelimiter(command, cursor);
  if (!delimiter) {
    throw new Error("Malformed SSH/OpenShell exec command: missing here-doc delimiter.");
  }
  return {
    pending: { delimiter: delimiter.value, stripLeadingTabs },
    endIndex: delimiter.endIndex,
  };
}

function readHeredocDelimiter(
  command: string,
  index: number,
): { value: string; endIndex: number } | null {
  let cursor = index;
  let delimiter = "";
  let quote: ExecCommandQuoteState = "plain";
  let escaping = false;
  while (cursor < command.length) {
    const char = command[cursor];
    if (escaping) {
      delimiter += char;
      escaping = false;
      cursor += 1;
      continue;
    }
    if (quote === "single") {
      if (char === "'") {
        quote = "plain";
      } else {
        delimiter += char;
      }
      cursor += 1;
      continue;
    }
    if (quote === "double") {
      if (char === '"') {
        quote = "plain";
      } else if (char === "\\") {
        escaping = true;
      } else {
        delimiter += char;
      }
      cursor += 1;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      cursor += 1;
      continue;
    }
    if (char === "'") {
      quote = "single";
      cursor += 1;
      continue;
    }
    if (char === '"') {
      quote = "double";
      cursor += 1;
      continue;
    }
    if (isHeredocDelimiterTerminator(char)) {
      break;
    }
    delimiter += char;
    cursor += 1;
  }
  if (quote !== "plain" || escaping) {
    throw new Error("Malformed SSH/OpenShell exec command: unterminated here-doc delimiter.");
  }
  return delimiter ? { value: delimiter, endIndex: cursor } : null;
}

function isHeredocDelimiterTerminator(char: string | undefined): boolean {
  return (
    char === undefined || /\s/.test(char) || [";", "&", "|", "(", ")", "<", ">"].includes(char)
  );
}

function skipHeredocBodies(
  command: string,
  index: number,
  pendingHeredocs: PendingHeredoc[],
): number {
  let cursor = index;
  for (const pending of pendingHeredocs) {
    let found = false;
    while (cursor <= command.length) {
      const lineEnd = command.indexOf("\n", cursor);
      const endIndex = lineEnd === -1 ? command.length : lineEnd;
      const rawLine = command.slice(cursor, endIndex);
      const normalizedLine = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      const line = pending.stripLeadingTabs ? normalizedLine.replace(/^\t+/, "") : normalizedLine;
      cursor = lineEnd === -1 ? command.length : lineEnd + 1;
      if (line === pending.delimiter) {
        found = true;
        break;
      }
      if (lineEnd === -1) {
        break;
      }
    }
    if (!found) {
      throw new Error(
        `Malformed SSH/OpenShell exec command: unterminated here-doc ${pending.delimiter}.`,
      );
    }
  }
  return cursor;
}

function isShellCommentStart(command: string, index: number): boolean {
  const previous = command[index - 1];
  return previous === undefined || /[\s;&|()]/.test(previous);
}

function skipShellComment(command: string, index: number): number {
  const newlineIndex = command.indexOf("\n", index);
  return newlineIndex === -1 ? command.length : newlineIndex;
}

export const ENSURE_REMOTE_REAL_DIRECTORY_SCRIPT = [
  "set -e",
  'target="$1"',
  'root="${2:-$1}"',
  'case "$target" in /*) ;; *) echo "remote directory must be absolute: $target" >&2; exit 1 ;; esac',
  'case "$root" in /*) ;; *) echo "remote root must be absolute: $root" >&2; exit 1 ;; esac',
  'target="${target%/}"',
  'root="${root%/}"',
  '[ -n "$target" ] || target="/"',
  '[ -n "$root" ] || root="/"',
  'case "$target/" in "$root"/*|"$root/") ;; *) echo "remote directory must stay under root: $target" >&2; exit 1 ;; esac',
  'for path_to_check in "$target" "$root"; do',
  '  relative="${path_to_check#/}"',
  '  while [ -n "$relative" ]; do',
  '    part="${relative%%/*}"',
  '    if [ "$part" = "$relative" ]; then relative=""; else relative="${relative#*/}"; fi',
  '    [ -n "$part" ] || continue',
  '    case "$part" in "."|"..") echo "unsafe remote directory component: $part" >&2; exit 1 ;; esac',
  "  done",
  "done",
  'if [ -L "$root" ]; then echo "unsafe remote root symlink: $root" >&2; exit 1; fi',
  'mkdir -p -- "$root"',
  'canonical_root="$(cd "$root" && pwd -P)"',
  'relative="${target#"$root"}"',
  'relative="${relative#/}"',
  'current="$canonical_root"',
  'while [ -n "$relative" ]; do',
  '  part="${relative%%/*}"',
  '  if [ "$part" = "$relative" ]; then relative=""; else relative="${relative#*/}"; fi',
  '  [ -n "$part" ] || continue',
  '  if [ "$current" = "/" ]; then next="/$part"; else next="$current/$part"; fi',
  '  if [ -L "$next" ]; then echo "unsafe remote directory symlink: $next" >&2; exit 1; fi',
  '  if [ -e "$next" ]; then',
  '    if [ ! -d "$next" ]; then echo "unsafe remote directory component: $next" >&2; exit 1; fi',
  "  else",
  '    mkdir -- "$next"',
  "  fi",
  '  current="$next"',
  "done",
].join("\n");
