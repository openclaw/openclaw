import { findCodeRegions, isInsideCode } from "../shared/text/code-regions.js";
import type { CliJsonlStreamingParserOptions, CliOutput } from "./cli-output-contracts.js";
import { isGeminiStreamJsonDialect, supportsCliJsonlToolEvents } from "./cli-output-records.js";
import { withCliRawFinalText } from "./cli-output-results.js";

export const CLI_STREAM_JSON_MISSING_RESULT_ERROR =
  "CLI stream-json output ended without a result event.";

const CLAUDE_INTERRUPTED_RAW_TOOL_PROTOCOL_ERROR =
  "Claude CLI interrupted during raw tool protocol.";

/**
 * Resolve the stream output when no result envelope was parsed. The text stays
 * the cumulative delivery reply; diagnostics receive only the model's final
 * message through `rawFinalText`.
 */
export function resolveCliStreamOutput(state: {
  params: CliJsonlStreamingParserOptions;
  texts: readonly string[];
  assistantText: string;
  sessionId: string | undefined;
  usage: CliOutput["usage"];
  resumeCheckpointId: string | undefined;
  rawLines: number;
  sawCustomJsonlEvent: boolean;
  sawGeminiStructuredOutput: boolean;
  claudeStreamJson: boolean;
  finalStreamedMessageText: () => string;
}): (CliOutput & { partialOutputRejected?: true }) | null {
  const {
    params,
    texts,
    assistantText,
    sessionId,
    usage,
    resumeCheckpointId,
    rawLines,
    sawCustomJsonlEvent,
    sawGeminiStructuredOutput,
    claudeStreamJson,
    finalStreamedMessageText,
  } = state;
  if (rawLines === 0) {
    return null;
  }
  let text = texts.join("\n");
  if (sawCustomJsonlEvent ? !text.trim() : supportsCliJsonlToolEvents(params)) {
    text = assistantText;
  }
  const settle = (o: CliOutput) => withCliRawFinalText(o, finalStreamedMessageText());
  const partialOutput = { text: text.trim(), sessionId, usage };
  // An unfinished stream cannot disambiguate raw protocol from a completed example.
  // Rejected partial output carries empty text, so it also reports no final message.
  if (claudeStreamJson) {
    const codeRegions = findCodeRegions(text);
    for (const match of text.matchAll(/(?:^|\n)[ \t]*<(?:invoke|parameter)(?=[\s/>]|$)/gu)) {
      if (!isInsideCode(match.index + match[0].lastIndexOf("<"), codeRegions)) {
        return {
          ...partialOutput,
          text: "",
          errorText: CLAUDE_INTERRUPTED_RAW_TOOL_PROTOCOL_ERROR,
          partialOutputRejected: true,
        };
      }
    }
  }
  if (sawCustomJsonlEvent || partialOutput.text) {
    return settle({
      ...partialOutput,
      ...(!sawCustomJsonlEvent && resumeCheckpointId ? { resumeCheckpointId } : {}),
    });
  }
  if (isGeminiStreamJsonDialect(params) && sawGeminiStructuredOutput) {
    return partialOutput;
  }
  if (supportsCliJsonlToolEvents(params)) {
    return {
      ...partialOutput,
      errorText: CLI_STREAM_JSON_MISSING_RESULT_ERROR,
    };
  }
  return null;
}
