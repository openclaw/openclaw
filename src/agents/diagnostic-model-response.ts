import { joinDiagnosticContent } from "../infra/diagnostic-content.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";

/**
 * Resolves model-authored final text for diagnostic capture: the model's own
 * final answer, or, for tool-only turns, the text the model sent through the
 * message tool as its reply. Nothing the host or a plugin produced (hook
 * replies, fallback/restart/error notices, delivery output) is ever returned.
 * Blocked and hook-handled turns never ran a model; errored runs may retain
 * genuine partial model output and keep it.
 */
export function resolveDiagnosticModelResponse(result: EmbeddedAgentRunResult): string | undefined {
  // Hook-handled turns record providerStarted: false; no model produced text.
  if (result.meta.livenessState === "blocked" || result.meta.providerStarted === false) {
    return undefined;
  }
  // finalAssistantVisibleText is never read: CLI settlement fills it with the
  // delivery mirror for tool-only turns, and every model-authored producer also
  // sets finalAssistantRawText.
  const rawText = result.meta.finalAssistantRawText;
  if (typeof rawText === "string" && rawText.trim()) {
    return rawText;
  }
  return resolveDiagnosticSourceReplyText(result);
}
type SourceReplyEvidence = Partial<
  Pick<EmbeddedAgentRunResult, "messagingToolSourceReplyPayloads" | "messagingToolSentTargets">
>;

/**
 * Model-authored message-tool reply text: the text arguments of message-tool sends
 * the runtime confirmed as final replies to the current source conversation
 * (internal-UI receipts and matched external sends carrying sourceReplyFinal).
 * Progress sends and sends to other destinations never qualify.
 */
export function resolveDiagnosticSourceReplyText(result: SourceReplyEvidence): string | undefined {
  const texts = [
    ...(result.messagingToolSourceReplyPayloads ?? [])
      .filter((receipt) => receipt.sourceReplyFinal !== false)
      .map((receipt) => receipt.text),
    ...(result.messagingToolSentTargets ?? [])
      .filter((send) => send.sourceReplyFinal === true)
      .map((send) => send.text),
  ].flatMap((text) => (typeof text === "string" && text.trim() ? [text] : []));
  return joinDiagnosticContent([...new Set(texts)]);
}
