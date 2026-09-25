// Text facts the CLI run result carries forward in its meta; owned here so the
// settlement owner (cli-run-settlement.ts) stays within the file line budget.
import type { CliOutput } from "../cli-output-contracts.js";

export function resolveCliRunResultTextMeta(params: {
  output: Pick<CliOutput, "terminalResultText" | "finalPromptText">;
  finalAssistantVisibleText: string | undefined;
  rawText: string | undefined;
}) {
  const { output, finalAssistantVisibleText, rawText } = params;
  return {
    ...(output.terminalResultText !== undefined
      ? { cliTerminalResultText: output.terminalResultText }
      : {}),
    ...(output.finalPromptText ? { finalPromptText: output.finalPromptText } : {}),
    ...(finalAssistantVisibleText ? { finalAssistantVisibleText } : {}),
    ...(rawText ? { finalAssistantRawText: rawText } : {}),
  };
}
