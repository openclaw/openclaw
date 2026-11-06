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
    },
  );
});
