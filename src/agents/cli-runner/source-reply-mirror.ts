import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { buildAgentRunTerminalReplySnapshot } from "../agent-run-terminal-reply.js";
import type { CliOutput } from "../cli-output-contracts.js";
import { resolveExplicitFinalSourceReplyDeliveryEvidence } from "../embedded-agent-runner/delivery-evidence.js";
import { buildEmbeddedRunPayloads } from "../embedded-agent-runner/run/payloads.js";
import { resolveReplyExpectation } from "../reply-completion.js";
import type { RunCliAgentParams } from "./types.js";

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
  terminalOutput?: CliOutput;
}): { payloads: ReplyPayload[]; delivered: boolean; visibleText?: string } {
  const { evidence, modelId, runParams, terminalOutput } = params;
  if (
    terminalOutput &&
    resolveReplyExpectation(runParams) === "required" &&
    resolveExplicitFinalSourceReplyDeliveryEvidence(terminalOutput) === false &&
    buildAgentRunTerminalReplySnapshot({
      visibleText: terminalOutput.text,
      rawText: terminalOutput.rawFinalText ?? terminalOutput.rawText,
    }).disposition === "visible"
  ) {
    return { payloads: [], delivered: false };
  }
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
    (runParams.sourceReplyDeliveryMode === "message_tool_only" &&
      evidence.didDeliverSourceReplyViaMessageTool === true);
  const visibleText =
    payloads
      .map((payload) => payload.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n\n") || undefined;
  return { payloads, delivered, visibleText };
}
