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
