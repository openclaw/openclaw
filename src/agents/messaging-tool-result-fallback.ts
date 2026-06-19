import type { OpenClawAgentToolResult } from "../plugins/agent-tool-result-middleware-types.js";
import {
  hasMessagingDeliveryReceipt,
  isDeliveredMessagingToolResult,
} from "./embedded-agent-message-tool-source-reply.js";
import { isMessagingToolSendAction } from "./embedded-agent-messaging.js";
import { readToolResultDetails } from "./tool-result-error.js";

/** Snapshots confirmed delivery before middleware can mutate the raw result in place. */
export function createDeliveredMessagingResultReconciler(params: {
  toolName: string;
  args: Record<string, unknown>;
  rawResult: OpenClawAgentToolResult;
  rawIsError: boolean;
}): (middlewareResult: OpenClawAgentToolResult) => OpenClawAgentToolResult {
  const confirmedDelivery =
    !params.rawIsError &&
    isMessagingToolSendAction(params.toolName, params.args) &&
    isDeliveredMessagingToolResult({
      toolName: params.toolName,
      args: params.args,
      result: params.rawResult,
    }) &&
    hasMessagingDeliveryReceipt(params.rawResult);
  const fallback: OpenClawAgentToolResult = {
    content: [
      {
        type: "text",
        text: "Message delivered, but result post-processing failed.",
      },
    ],
    details: {
      ok: true,
      deliveryStatus: "sent",
      middlewareWarning: "post-processing failed",
    },
  };
  return (middlewareResult) =>
    confirmedDelivery && readToolResultDetails(middlewareResult)?.middlewareError === true
      ? fallback
      : middlewareResult;
}
