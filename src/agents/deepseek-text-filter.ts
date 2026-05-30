const DSML_KINDS = ["tool_use_error", "tool_calls", "tool_call", "function_calls"] as const;
const DSML_BARS = ["|", "｜"] as const;

const DSML_TOKEN_PAIRS = DSML_BARS.flatMap((bar) =>
  DSML_KINDS.map((kind) => ({
    kind,
    open: `<${bar}DSML${bar}${kind}>`,
    close: `</${bar}DSML${bar}${kind}>`,
  })),
);
const DSML_OPEN_TOKENS = DSML_TOKEN_PAIRS.map((token) => token.open);
const MAX_OPEN_TOKEN_LEN = Math.max(...DSML_OPEN_TOKENS.map((token) => token.length));
const MAX_CLOSE_TOKEN_LEN = Math.max(...DSML_TOKEN_PAIRS.map((token) => token.close.length));
const MAX_DSML_BODY_BYTES = 256_000;

export interface DeepSeekTextFilter {
  push(chunk: string): string[];
  flush(): string[];
}

export function createDeepSeekTextFilter(): DeepSeekTextFilter {
  const filter = createDeepSeekTextEventFilter();
  const textParts = (events: DeepSeekTextFilterEvent[]) =>
    events.flatMap((event) => (event.type === "text" ? [event.text] : []));

  return {
    push(chunk: string) {
      return textParts(filter.push(chunk));
    },
    flush() {
      return textParts(filter.flush());
    },
  };
}

export type DeepSeekDsmlKind = (typeof DSML_KINDS)[number];

export type DeepSeekTextFilterEvent =
  | { type: "text"; text: string }
  | { type: "dsml"; kind: DeepSeekDsmlKind; body: string };

export interface DeepSeekTextEventFilter {
  push(chunk: string): DeepSeekTextFilterEvent[];
  flush(): DeepSeekTextFilterEvent[];
}

export function createDeepSeekTextEventFilter(): DeepSeekTextEventFilter {
  let buffer = "";
  let insideDsml: {
    kind: DeepSeekDsmlKind;
    body: string;
    bodyBytes: number;
    truncated: boolean;
  } | null = null;

  const appendDsmlBody = (text: string) => {
    if (!insideDsml || insideDsml.truncated || !text) {
      return;
    }
    const nextBytes = Buffer.byteLength(text, "utf8");
    if (insideDsml.bodyBytes + nextBytes > MAX_DSML_BODY_BYTES) {
      insideDsml.body = "";
      insideDsml.bodyBytes = 0;
      insideDsml.truncated = true;
      return;
    }
    insideDsml.body += text;
    insideDsml.bodyBytes += nextBytes;
  };

  const consume = (final: boolean): DeepSeekTextFilterEvent[] => {
    const output: DeepSeekTextFilterEvent[] = [];
    const emit = (text: string) => {
      if (text) {
        output.push({ type: "text", text });
      }
    };

    while (buffer) {
      if (insideDsml) {
        const close = findEarliestCloseTokenPair(buffer, DSML_TOKEN_PAIRS);
        if (close) {
          appendDsmlBody(buffer.slice(0, close.index));
          if (
            !insideDsml.truncated &&
            isCompatibleDsmlCloseKind(insideDsml.kind, close.token.kind)
          ) {
            output.push({
              type: "dsml",
              kind: insideDsml.kind,
              body: insideDsml.body,
            });
          }
          buffer = buffer.slice(close.index + close.token.close.length);
          insideDsml = null;
          continue;
        }
        const keep = final ? 0 : Math.min(buffer.length, MAX_CLOSE_TOKEN_LEN - 1);
        const consumedLength = buffer.length - keep;
        appendDsmlBody(buffer.slice(0, consumedLength));
        buffer = buffer.slice(consumedLength);
        if (final) {
          insideDsml = null;
        }
        return output;
      }

      const open = findEarliestTokenPair(buffer, DSML_TOKEN_PAIRS);
      if (open) {
        emit(buffer.slice(0, open.index));
        buffer = buffer.slice(open.index + open.token.open.length);
        insideDsml = { kind: open.token.kind, body: "", bodyBytes: 0, truncated: false };
        continue;
      }

      if (final) {
        emit(buffer);
        buffer = "";
        return output;
      }

      const keep = longestDsmlOpenPrefixSuffixLength(buffer);
      const emitLength = buffer.length - keep;
      if (emitLength <= 0) {
        return output;
      }
      emit(buffer.slice(0, emitLength));
      buffer = buffer.slice(emitLength);
      return output;
    }
    return output;
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      return consume(false);
    },
    flush() {
      return consume(true);
    },
  };
}

function isCompatibleDsmlCloseKind(openKind: DeepSeekDsmlKind, closeKind: DeepSeekDsmlKind) {
  if (openKind === closeKind) {
    return true;
  }
  return isDsmlToolCallFamilyKind(openKind) && isDsmlToolCallFamilyKind(closeKind);
}

function isDsmlToolCallFamilyKind(kind: DeepSeekDsmlKind) {
  return kind === "tool_calls" || kind === "tool_call" || kind === "function_calls";
}

function findEarliestCloseTokenPair(
  text: string,
  tokens: readonly { kind: DeepSeekDsmlKind; close: string }[],
) {
  let best: {
    index: number;
    token: { kind: DeepSeekDsmlKind; close: string };
  } | null = null;
  for (const token of tokens) {
    const index = text.indexOf(token.close);
    if (index !== -1 && (!best || index < best.index)) {
      best = { index, token };
    }
  }
  return best;
}

function findEarliestTokenPair(
  text: string,
  tokens: readonly { kind: DeepSeekDsmlKind; open: string }[],
) {
  let best: {
    index: number;
    token: { kind: DeepSeekDsmlKind; open: string };
  } | null = null;
  for (const token of tokens) {
    const index = text.indexOf(token.open);
    if (index !== -1 && (!best || index < best.index)) {
      best = { index, token };
    }
  }
  return best;
}

function longestDsmlOpenPrefixSuffixLength(text: string) {
  const maxLength = Math.min(text.length, MAX_OPEN_TOKEN_LEN - 1);
  for (let length = maxLength; length > 0; length--) {
    const suffix = text.slice(text.length - length);
    if (DSML_OPEN_TOKENS.some((token) => token.startsWith(suffix))) {
      return length;
    }
  }
  return 0;
}
