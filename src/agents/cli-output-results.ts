import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { PluginTextReplacement } from "../plugins/cli-backend.types.js";
import type { CliOutput } from "./cli-output-contracts.js";
import { applyPluginTextReplacements } from "./plugin-text-transforms.js";

export function transformCliResultText(
  output: CliOutput,
  replacements?: PluginTextReplacement[],
): CliOutput {
  return {
    ...output,
    rawText: output.text,
    text: applyPluginTextReplacements(output.text, replacements),
    ...(output.textParts
      ? {
          textParts: output.textParts.map((text) =>
            applyPluginTextReplacements(text, replacements),
          ),
        }
      : {}),
  };
}

/** Records the model's final message when it differs from the cumulative delivery text. */
export function withCliRawFinalText(output: CliOutput, finalMessageText: string): CliOutput {
  if (finalMessageText !== output.text.trim()) {
    return { ...output, rawFinalText: finalMessageText };
  }
  // A replacement result spreads the earlier output; drop its stale final message.
  const { rawFinalText: _staleFinalText, ...current } = output;
  return current;
}

/** Keep completed answers distinct while retaining cumulative transcript text. */
export function appendCliResultText(previous: CliOutput | null, nextText: string) {
  const previousText = previous?.text.trim() ?? "";
  // Each result commits its own answer. Only assistant snapshots are cumulative;
  // a shared prefix cannot distinguish a new answer ("Hi" -> "History") from one.
  const previousParts = previous?.textParts ?? (previousText ? [previousText] : []);
  const completedText = nextText === previousParts.at(-1) ? "" : nextText;
  const text = completedText
    ? previousText
      ? `${previousText}\n${completedText}`
      : completedText
    : previousText;
  const textParts = completedText ? [...previousParts, completedText] : previousParts;
  return { text, textParts, completedText };
}

/**
 * Stores a record's message item text and returns the text that is still the
 * final message: a later tool item ends it, like a tool_use block does.
 */
export function recordItemText(
  parsed: Record<string, unknown>,
  texts: string[],
  finalItemText: string | undefined,
): string | undefined {
  const item = isRecord(parsed.item) ? parsed.item : null;
  if (!item) {
    return finalItemText;
  }
  const type = normalizeLowercaseStringOrEmpty(item.type);
  if (!type || type.includes("message")) {
    if (typeof item.text !== "string") {
      return finalItemText;
    }
    texts.push(item.text);
    return item.text;
  }
  return type.includes("reasoning") ? finalItemText : undefined;
}
