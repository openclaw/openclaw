import { sanitizeAgentRunTerminalReply } from "../../agent-run-terminal-reply.js";
import { withAgentTerminalPayloadSnapshot } from "../../agent-terminal-snapshot.js";
import type { EmbeddedAgentMeta, EmbeddedAgentRunResult } from "../types.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

export function buildEmbeddedRunBlockedResult(input: {
  text: string;
  errorKind: NonNullable<EmbeddedAgentRunResult["meta"]["error"]>["kind"];
  errorMessage: string;
  durationMs: number;
  agentMeta: EmbeddedAgentMeta;
  attempt?: Pick<EmbeddedRunAttemptResult, "systemPromptReport" | "agentTerminal" | "terminal">;
  replayInvalid: boolean;
  finalPromptText?: string;
}): EmbeddedAgentRunResult {
  const agentTerminal =
    input.attempt?.terminal.kind === "failed" &&
    input.attempt.terminal.source === "prompt" &&
    !input.replayInvalid
      ? input.attempt.agentTerminal
      : undefined;
  return {
    payloads: [
      withAgentTerminalPayloadSnapshot({ text: input.text, isError: true }, agentTerminal),
    ],
    meta: {
      durationMs: input.durationMs,
      agentMeta: input.agentMeta,
      agentTerminal,
      systemPromptReport: input.attempt?.systemPromptReport,
      finalAssistantVisibleText: input.text,
      finalAssistantRawText: input.text,
      terminalReply: sanitizeAgentRunTerminalReply(input.text),
      finalPromptText: input.finalPromptText,
      replayInvalid: input.replayInvalid,
      livenessState: "blocked",
      error: { kind: input.errorKind, message: input.errorMessage },
    },
  };
}
