const DSML_KINDS = ["tool_use_error", "tool_calls", "tool_call", "function_calls"] as const;
const DSML_BARS = ["|", "｜"] as const;

const DSML_OPEN_TOKENS = DSML_BARS.flatMap((bar) =>
  DSML_KINDS.map((kind) => `<${bar}DSML${bar}${kind}>`),
);
const DSML_CLOSE_TOKENS = DSML_BARS.flatMap((bar) =>
  DSML_KINDS.map((kind) => `</${bar}DSML${bar}${kind}>`),
);
const MAX_OPEN_TOKEN_LEN = Math.max(...DSML_OPEN_TOKENS.map((token) => token.length));
const MAX_CLOSE_TOKEN_LEN = Math.max(...DSML_CLOSE_TOKENS.map((token) => token.length));

export interface DeepSeekTextFilter {
  push(chunk: string): string[];
  flush(): string[];
}

export function createDeepSeekTextFilter(): DeepSeekTextFilter {
  let buffer = "";
  let insideDsml = false;

  const consume = (final: boolean): string[] => {
    const output: string[] = [];
    const emit = (text: string) => {
      if (text) {
        output.push(text);
      }
    };

    while (buffer) {
      if (insideDsml) {
        const close = findEarliestToken(buffer, DSML_CLOSE_TOKENS);
        if (close) {
          buffer = buffer.slice(close.index + close.token.length);
          insideDsml = false;
          continue;
        }
        const keep = final ? 0 : Math.min(buffer.length, MAX_CLOSE_TOKEN_LEN - 1);
        buffer = buffer.slice(buffer.length - keep);
        if (final) {
          insideDsml = false;
        }
        return output;
      }

      const open = findEarliestToken(buffer, DSML_OPEN_TOKENS);
      if (open) {
        emit(buffer.slice(0, open.index));
        buffer = buffer.slice(open.index + open.token.length);
        insideDsml = true;
        continue;
      }

      if (final) {
        emit(buffer);
        buffer = "";
        return output;
      }

      const emitLength = buffer.length - Math.min(buffer.length, MAX_OPEN_TOKEN_LEN - 1);
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

function findEarliestToken(text: string, tokens: readonly string[]) {
  let best: { index: number; token: string } | null = null;
  for (const token of tokens) {
    const index = text.indexOf(token);
    if (index !== -1 && (!best || index < best.index)) {
      best = { index, token };
    }
  }
  return best;
}
