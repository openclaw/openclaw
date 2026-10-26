import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  prepareAgentRunTerminalReply,
  sanitizeAgentRunTerminalReply,
} from "../agent-run-terminal-reply.js";
import type { CliOutput } from "../cli-output-contracts.js";
import {
  hasCompletedSourceReplyDeliveryEvidence,
  resolveExplicitFinalSourceReplyDeliveryEvidence,
} from "../embedded-agent-runner/delivery-evidence.js";
import { buildEmbeddedRunPayloads } from "../embedded-agent-runner/run/payloads.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { resolveReplyExpectation } from "../reply-completion.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

export function resolveCliSourceReplyMirror(params: {
  evidence: Pick<
    CliOutput,
    | "didSendViaMessagingTool"
    | "didDeliverSourceReplyViaMessageTool"
    | "messagingToolSentTargets"
    | "messagingToolSourceReplyPayloads"
  >;
  runParams: RunCliAgentParams;
  modelId: string;
}): { payloads: ReplyPayload[]; delivered: boolean; visibleText?: string } {
  const { evidence, modelId, runParams } = params;
  const payloads = buildEmbeddedRunPayloads({
    assistantTexts: [],
    lastAssistant: undefined,
    sessionKey: runParams.sessionKey ?? "",
    provider: runParams.provider,
    model: modelId,
    didSendViaMessagingTool: evidence.didSendViaMessagingTool,
    didDeliverSourceReplyViaMessageTool: evidence.didDeliverSourceReplyViaMessageTool,
    messagingToolSentTargets: evidence.messagingToolSentTargets,
    messagingToolSourceReplyPayloads: evidence.messagingToolSourceReplyPayloads,
    sourceReplyDeliveryMode: runParams.sourceReplyDeliveryMode,
    agentId: runParams.agentId,
    runId: runParams.runId,
  });
  const delivered =
    payloads.length > 0 ||
    // External source sends have receipts but no internal-UI mirror body.
    (evidence.didDeliverSourceReplyViaMessageTool === true &&
      (runParams.sourceReplyDeliveryMode === "message_tool_only" ||
        hasCompletedSourceReplyDeliveryEvidence(evidence)));
  const visibleText =
    payloads
      .map((payload) => payload.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n\n") || undefined;
  return { payloads, delivered, visibleText };
}

export function prepareCliRunTerminalReply(context: PreparedCliRunContext, output: CliOutput) {
  let sourceReplyMirror = resolveCliSourceReplyMirror({
    evidence: output,
    runParams: context.params,
    modelId: context.modelId,
  });
  const completedFinalSource =
    sourceReplyMirror.payloads.length > 0 &&
    resolveExplicitFinalSourceReplyDeliveryEvidence(output) === true &&
    hasCompletedSourceReplyDeliveryEvidence(output);
  if (resolveReplyExpectation(context.params) === "result-required" && !completedFinalSource) {
    sourceReplyMirror = { payloads: [], delivered: false };
  }
  // A delivery receipt without a mirrored body must not replace authored silence with empty output.
  if (sourceReplyMirror.visibleText !== undefined) {
    const text = sourceReplyMirror.visibleText;
    return {
      sourceReplyMirror,
      completedFinalSource,
      text,
      terminalReply: sanitizeAgentRunTerminalReply(text),
    };
  }
  const rawText = output.rawFinalText ?? output.rawText ?? output.text;
  const prepared = prepareAgentRunTerminalReply({ rawText });
  const finalText =
    prepared.terminalReply.disposition === "silent"
      ? ""
      : prepared.text === rawText && output.rawFinalText === undefined
        ? (output.text ?? "")
        : applyPluginTextReplacements(
            prepared.text,
            context.backendResolved.textTransforms?.output,
          );
  const text =
    prepared.terminalReply.disposition === "visible" &&
    output.rawFinalText !== undefined &&
    prepared.text === rawText
      ? output.text
      : finalText;
  return {
    sourceReplyMirror,
    completedFinalSource,
    text,
    terminalReply:
      prepared.terminalReply.disposition === "visible"
        ? sanitizeAgentRunTerminalReply(finalText)
        : prepared.terminalReply,
  };
}
