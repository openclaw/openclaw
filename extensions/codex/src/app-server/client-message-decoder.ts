const PARSE_BUFFER_MAX = 8 * 1024 * 1024;
const PARSE_BUFFER_MAX_LINES = 1_000;
const UNICODE_ESCAPE_QUAD = /^[\da-fA-F]{4}$/u;

type PendingMessage = {
  fragments: string[];
  length: number;
  inString: boolean;
};

/** Recovers the raw newlines observed inside native JSON string values. */
export class CodexAppServerMessageDecoder {
  private pending: PendingMessage | undefined;

  constructor(
    private readonly reportError: (value: string, error: unknown, fragmentCount: number) => void,
  ) {}

  clear(): void {
    this.pending = undefined;
  }

  get hasPending(): boolean {
    return this.pending !== undefined;
  }

  parse(line: string): unknown {
    const rawLine = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (this.pending) {
      return this.parseContinuation(rawLine, this.pending);
    }
    const trimmed = rawLine.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      const text = rawLine.trimStart();
      const inString = recoverableJsonStringState(text, error);
      if (inString !== undefined) {
        this.pending = {
          fragments: [text],
          length: text.length,
          inString,
        };
      } else {
        this.reportError(trimmed, error, 1);
      }
    }
    return undefined;
  }

  private parseContinuation(line: string, pending: PendingMessage): unknown {
    pending.fragments.push(line);
    pending.length += 2 + line.length;
    const withinBounds =
      pending.length <= PARSE_BUFFER_MAX && pending.fragments.length <= PARSE_BUFFER_MAX_LINES;
    // The inserted escaped newline is valid when the prior string has no partial escape.
    if (withinBounds && pending.inString && scanJsonString(line, 0) === line.length) {
      return undefined;
    }
    const candidate = pending.fragments.join("\\n");
    this.pending = undefined;
    try {
      return JSON.parse(candidate);
    } catch (error) {
      // Completed messages still parse above the incomplete-recovery bounds.
      const inString = withinBounds ? recoverableJsonStringState(candidate, error) : undefined;
      if (inString !== undefined) {
        pending.inString = inString;
        this.pending = pending;
      } else {
        this.reportError(candidate, error, pending.fragments.length);
      }
    }
    return undefined;
  }
}

/** Undefined rejects malformed JSON; false retains a trailing escape for native parsing. */
function recoverableJsonStringState(value: string, error: unknown): boolean | undefined {
  if (!(error instanceof SyntaxError) || (!value.startsWith("{") && !value.startsWith("["))) {
    return undefined;
  }
  const closers: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "{" || character === "[") {
      closers.push(character === "{" ? "}" : "]");
    } else if (character === "}" || character === "]") {
      closers.pop();
    }
    if (character !== '"') {
      continue;
    }
    const end = scanJsonString(value, index + 1);
    if (end < 0) {
      return undefined;
    }
    if (end >= value.length) {
      const closing = closers.toReversed().join("");
      for (const suffix of ['"', '":null']) {
        try {
          JSON.parse(`${value}\\n${suffix}${closing}`);
          return end === value.length;
        } catch {
          // An unfinished string may be an object key instead of a value.
        }
      }
      return undefined;
    }
    index = end;
  }
  return undefined;
}

/** Finds a closing quote; incomplete or invalid escapes require native parsing. */
function scanJsonString(value: string, start: number): number {
  for (let index = start; index < value.length; index++) {
    const character = value[index];
    if (character === '"') {
      return index;
    }
    if (value.charCodeAt(index) < 0x20) {
      return -1;
    }
    if (character !== "\\") {
      continue;
    }
    const escape = value[++index];
    if (!escape) {
      return value.length + 1;
    } else if (escape === "u") {
      if (!UNICODE_ESCAPE_QUAD.test(value.slice(index + 1, index + 5))) {
        return -1;
      }
      index += 4;
    } else if (!'"\\/bfnrt'.includes(escape)) {
      return -1;
    }
  }
  return value.length;
}
