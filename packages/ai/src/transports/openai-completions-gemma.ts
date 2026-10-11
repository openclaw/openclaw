import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { measureUtf8AppendBytes } from "./openai-transport-shared.js";
import type { TextToolCallRecoveryPart } from "./text-tool-call-recovery.js";

const OPEN = "<|tool_call>";
const CLOSE = "<tool_call|>";
const QUOTE = '<|"|>';
const MAX_RECOVERY_BYTES = 256_000;

// Gemma strings are raw: JSON quoting must preserve their contents, including
// backslashes, newlines and closing-tool-marker lookalikes.
function recoverGemmaCalls(text: string): TextToolCallRecoveryPart[] | undefined {
  const parts: TextToolCallRecoveryPart[] = [];
  const opener = /\s*<\|tool_call>\s*call:([\w.-]+)\s*/y;
  const token = /\s*(<\|"\|>[\s\S]*?<\|"\|>|[\w.+-]+|[{}[\],:])\s*/y;
  let offset = 0;
  while (offset < text.length) {
    if (!text.slice(offset).trim()) {
      parts.push({ kind: "text", text: text.slice(offset) });
      break;
    }
    opener.lastIndex = offset;
    const head = opener.exec(text);
    const name = head?.[1];
    if (!head || !name) {
      return undefined;
    }
    const leading = /^\s*/.exec(head[0])?.[0] ?? "";
    if (leading) {
      parts.push({ kind: "text", text: leading });
    }
    token.lastIndex = opener.lastIndex;
    let depth = 0;
    const json: string[] = [];
    do {
      const next = token.exec(text);
      const value = next?.[1];
      if (!value || (json.length === 0 && value !== "{")) {
        return undefined;
      }
      if (value === "{") {
        depth += 1;
      } else if (value === "}") {
        depth -= 1;
      }
      json.push(
        value.startsWith(QUOTE)
          ? JSON.stringify(value.slice(QUOTE.length, -QUOTE.length))
          : text[token.lastIndex] === ":" && /^[A-Za-z_][\w.-]*$/.test(value)
            ? JSON.stringify(value)
            : value,
      );
    } while (depth > 0);
    if (!text.startsWith(CLOSE, token.lastIndex)) {
      return undefined;
    }
    try {
      const argumentsValue: unknown = JSON.parse(json.join(" "));
      if (!isRecord(argumentsValue)) {
        return undefined;
      }
      parts.push({
        kind: "toolCall",
        name,
        arguments: argumentsValue,
        partialArgs: JSON.stringify(argumentsValue),
      });
    } catch {
      return undefined;
    }
    offset = token.lastIndex + CLOSE.length;
  }
  return parts;
}

/** Buffer only a possible standalone call batch; prose and examples stay text. */
export function createGemmaToolCallRecoverer() {
  let buffer = "";
  let bytes = 0;
  let highSurrogate = false;
  let passthrough = false;
  return {
    push(text: string): { kind: "text"; text: string }[] {
      if (passthrough) {
        return [{ kind: "text", text }];
      }
      const append = measureUtf8AppendBytes(highSurrogate, text);
      bytes += append.bytes;
      highSurrogate = append.endsWithHighSurrogate;
      buffer += text;
      const candidate = buffer.trimStart();
      if (OPEN.startsWith(candidate) || candidate.startsWith(OPEN)) {
        if (bytes > MAX_RECOVERY_BYTES) {
          throw new Error("Exceeded Gemma tool-call recovery buffer limit");
        }
        return [];
      }
      passthrough = true;
      const result: { kind: "text"; text: string }[] = [{ kind: "text", text: buffer }];
      buffer = "";
      return result;
    },
    flush(allowRecovery = true): TextToolCallRecoveryPart[] {
      const text = buffer;
      buffer = "";
      passthrough ||= !allowRecovery;
      const recovered = allowRecovery ? recoverGemmaCalls(text) : undefined;
      return text ? (recovered ?? [{ kind: "text", text }]) : [];
    },
  };
}
