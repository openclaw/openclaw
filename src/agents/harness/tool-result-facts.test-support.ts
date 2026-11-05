import type { AgentToolResult } from "../../../packages/agent-core/src/types.js";
import { extractMessagingToolSourceReplyPayload } from "../embedded-agent-messaging-extraction.js";
import { collectMessagingMediaUrlsFromRecord } from "../embedded-agent-tool-media.js";
import {
  recordAgentHarnessToolResultTelemetry,
  type AgentHarnessToolResultTelemetry,
} from "./tool-result-facts.js";

export function textToolResult(text: string, details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

export function createTelemetry(): AgentHarnessToolResultTelemetry {
  return {
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSourceReplyPayloads: [],
    confirmedMediaDeliveries: [],
    toolMediaUrls: [],
    toolAutoDeliveryMediaUrls: [],
    coreTtsToolResults: [],
    toolAudioAsVoice: false,
  };
}

type TelemetryParams = Parameters<typeof recordAgentHarnessToolResultTelemetry>[0];
export function recordTelemetry(
  params: Pick<TelemetryParams, "toolName" | "result"> &
    Partial<
      Pick<
        TelemetryParams,
        "telemetry" | "args" | "isError" | "messagingDelivered" | "mediaDeliveryConfirmed"
      >
    >,
) {
  const telemetry = params.telemetry ?? createTelemetry();
  recordAgentHarnessToolResultTelemetry({
    args: {},
    isError: false,
    messagingDelivered: false,
    mediaDeliveryConfirmed: false,
    extractSourceReplyPayload: extractMessagingToolSourceReplyPayload,
    collectMessagingMediaUrls: collectMessagingMediaUrlsFromRecord,
    resolveMessagingMediaSourceUrls: (urls) => urls,
    signal: new AbortController().signal,
    ...params,
    telemetry,
  });
  return telemetry;
}
