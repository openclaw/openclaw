import { describe, expect, it } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
  anthropicModel,
  context,
  createAnthropicResponse,
  registerParityHostLifecycle,
} from "../provider-transport-parity.test-support.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";

registerParityHostLifecycle();

describe("Anthropic streamed errors", () => {
  it.each(["rate_limit_error", "overloaded_error", "authentication_error"])(
    "preserves %s metadata for provider recovery",
    async (errorType) => {
      const error = { type: errorType, message: "Synthetic provider failure" };
      configureAiTransportHost({
        ...getAiTransportHost(),
        buildModelFetch: () => async () => createAnthropicResponse([{ type: "error", error }]),
      });

      const stream = await createAnthropicMessagesTransportStreamFn()(anthropicModel, context, {
        apiKey: ["synthetic", "credential"].join("-"),
      });
      const result = await stream.result();

      expect(result).toMatchObject({
        stopReason: "error",
        errorMessage: error.message,
        errorType,
      });
      expect(JSON.parse(result.errorBody ?? "null")).toEqual(error);
      // Rejected before the message started: the provider did no billable work.
      expect(result.usage).toMatchObject({ totalTokens: 0, usageReport: { state: "available" } });
    },
  );

  it("keeps usage unavailable when a stream fails after tool-call output", async () => {
    const error = { type: "overloaded_error", message: "Synthetic provider failure" };
    configureAiTransportHost({
      ...getAiTransportHost(),
      buildModelFetch: () => async () =>
        createAnthropicResponse([
          {
            type: "message_start",
            // Zero output isolates the streamed tool call as the evidence of generated output.
            message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"path":' },
          },
          { type: "error", error },
        ]),
    });

    const stream = await createAnthropicMessagesTransportStreamFn()(anthropicModel, context, {
      apiKey: ["synthetic", "credential"].join("-"),
    });
    const result = await stream.result();

    // Cleanup drops the partial tool call, but the turn generated billed output.
    expect(result).toMatchObject({ stopReason: "error", content: [] });
    expect(result.usage.usageReport).toEqual({ state: "unavailable" });
  });
});
