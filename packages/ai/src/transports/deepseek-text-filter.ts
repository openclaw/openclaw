import {
  DEEPSEEK_DSML_MARKERS,
  findEarliestDsmlToken,
  longestDsmlTokenPrefixSuffixLength,
} from "./deepseek-dsml-grammar.js";

/**
 * DeepSeek DSML streaming text filter.
 * Removes provider-emitted DSML tool markup while buffering split tag prefixes
 * across streamed chunks.
 */
const DSML_KINDS = ["tool_use_error", "tool_calls", "tool_call", "function_calls"] as const;

const DSML_OPEN_TOKENS = DEEPSEEK_DSML_MARKERS.flatMap((marker) =>
  DSML_KINDS.map((kind) => `<${marker}${kind}>`),
);
const MAX_OPEN_TOKEN_LEN = Math.max(...DSML_OPEN_TOKENS.map((token) => token.length));

/** Create an incremental text filter that strips DeepSeek DSML tool blocks. */
export function createDeepSeekTextFilter() {
  let buffer = "";
  // Only the matching delimiter and kind may end the block being suppressed.
  let closeToken: string | undefined;

  const consume = (final: boolean): string[] => {
    const output: string[] = [];
    const emit = (text: string) => {
      if (text) {
        output.push(text);
      }
    };

    while (buffer) {
      if (closeToken) {
        const closeIndex = buffer.indexOf(closeToken);
        if (closeIndex !== -1) {
          buffer = buffer.slice(closeIndex + closeToken.length);
          closeToken = undefined;
          continue;
        }
        // Keep a suffix that could still become a closing tag once the next
        // streamed chunk arrives; on final flush, drop the unterminated block.
        const keep = final ? 0 : Math.min(buffer.length, closeToken.length - 1);
        buffer = buffer.slice(buffer.length - keep);
        if (final) {
          closeToken = undefined;
        }
        return output;
      }

      const open = findEarliestDsmlToken(buffer, DSML_OPEN_TOKENS);
      if (open) {
        emit(buffer.slice(0, open.index));
        buffer = buffer.slice(open.index + open.token.length);
        closeToken = open.token.replace("<", "</");
        continue;
      }

      if (final) {
        emit(buffer);
        buffer = "";
        return output;
      }

      const keep = longestDsmlTokenPrefixSuffixLength(buffer, DSML_OPEN_TOKENS, MAX_OPEN_TOKEN_LEN);
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
    hasPending() {
      // An open suppression span (close token set) is pending even when the
      // buffer is empty, or a released prefix can be misclassified as a
      // complete replay while the span is still consuming.
      return buffer.length > 0 || closeToken !== undefined;
    },
  };
}
