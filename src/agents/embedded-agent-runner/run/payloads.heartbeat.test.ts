// Exercise the full tool-failure and media pipeline before the notification decision.
import { describe, expect, it } from "vitest";
import { resolveHeartbeatReplyPayload } from "../../../auto-reply/heartbeat-reply-payload.js";
import { selectHeartbeatToolResponse } from "../../../auto-reply/heartbeat-tool-response.js";
import { classifyHeartbeatAgentOutcome } from "../../../infra/heartbeat-delivery-normalization.js";
import { buildPayloads } from "./payloads.test-helpers.js";
import { mergeAttemptToolMediaPayloads } from "./tool-media-payloads.js";

describe("quiet heartbeat failures", () => {
  it.each(["message", "exec", "bash"])(
    "does not notify after a failed %s and generated media",
    (toolName) => {
      const payloads = buildPayloads({
        assistantTexts: ["Everything is fine."],
        heartbeatToolResponse: {
          outcome: "no_change",
          notify: false,
          summary: "Nothing needs attention.",
        },
        isHeartbeatTrigger: true,
        lastToolError: { toolName, error: "operation failed", mutatingAction: true },
      });
      const merged = mergeAttemptToolMediaPayloads({
        payloads,
        toolMediaUrls: ["/tmp/heartbeat.png"],
        hostOwnedToolMediaUrls: ["/tmp/heartbeat.png"],
        toolAutoDeliveryMediaUrls: ["/tmp/heartbeat.opus"],
        toolAudioAsVoice: true,
        sourceReplyDeliveryMode: "message_tool_only",
      });
      expect(
        classifyHeartbeatAgentOutcome({
          agentRun: {
            agentRunFailed: false,
            heartbeatToolResponse: selectHeartbeatToolResponse(merged)?.response,
            heartbeatTerminalToolFailure: { toolName },
            replyPayload: resolveHeartbeatReplyPayload(merged),
          },
          hasRelayableExecCompletion: false,
          suppressUnmarkedSourceReplies: false,
          responsePrefix: undefined,
          ackMaxChars: 300,
        }),
      ).toMatchObject({ kind: "failure", reason: "agent-tool-failure", shouldSkipMain: true });
    },
  );
});
