import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";
import {
  anthropicMessageDelta,
  anthropicMessageStart,
  createSseResponse,
  installAnthropicTransportTestHost,
  makeAnthropicTransportModel,
} from "./anthropic-transport-stream.test-support.js";

const buildGuardedModelFetchMock = vi.fn();
const guardedFetchMock = vi.fn();
const coreTransportHost = getAiTransportHost();

describe("Anthropic-compatible sensitive stops", () => {
  beforeEach(() => {
    installAnthropicTransportTestHost({
      coreTransportHost,
      buildModelFetch: buildGuardedModelFetchMock,
      guardedFetch: guardedFetchMock,
    });
  });

  afterAll(() => {
    configureAiTransportHost(coreTransportHost);
  });

  it("treats a Z.AI sensitive stop as a provider refusal", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        anthropicMessageStart({
          id: "msg_sensitive",
          usage: { input_tokens: 4, output_tokens: 0 },
        }),
        anthropicMessageDelta({ stop_reason: "sensitive" }, { input_tokens: 4, output_tokens: 1 }),
        { type: "message_stop" },
      ]),
    );

    const stream = await createAnthropicMessagesTransportStreamFn()(
      makeAnthropicTransportModel({
        id: "glm-4.6",
        name: "GLM 4.6",
        provider: "zai",
        baseUrl: "https://api.z.ai/api/anthropic",
        reasoning: false,
      }),
      { messages: [makeUserMessage("hello", 0)] },
      { apiKey: "zai-synthetic-key" },
    );
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toBe("An unknown error occurred");
    expect(result.errorMessage).toBe("Anthropic refusal.");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        type: "provider_refusal",
        details: {
          provider: "zai",
          category: null,
          explanation: null,
        },
      }),
    ]);
  });
});
