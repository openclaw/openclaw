// Managed Responses replay preserves native video only for explicitly capable vendor models.
import { describe, expect, it } from "vitest";
import type { Context, Model } from "../types.js";
import { convertResponsesMessages } from "./openai-responses-replay-internal.js";

const baseModel = {
  id: "test-model",
  name: "Test model",
  api: "openai-responses",
  provider: "custom-video-provider",
  baseUrl: "https://proxy.example/v1",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} satisfies Model<"openai-responses">;

const videoModel = {
  ...baseModel,
  input: ["text", "image", "video"],
} satisfies Model<"openai-responses">;

const allowedToolCallProviders = new Set<string>();

describe("managed Responses native video replay", () => {
  it("preserves video-capable user input as the vendor input_video extension", () => {
    const input = convertResponsesMessages(
      videoModel,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Inspect clip" },
              { type: "video", mimeType: "video/mp4", data: "dmlkZW8=" },
            ],
            timestamp: 1,
          },
        ],
      } satisfies Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false },
    );

    expect(input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Inspect clip" },
          { type: "input_video", video_url: "data:video/mp4;base64,dmlkZW8=" },
        ],
      },
    ]);
  });

  it("never invents input_video for a first-party OpenAI model", () => {
    const openAIModel = { ...baseModel, provider: "openai" };
    const input = convertResponsesMessages(
      openAIModel,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "video", mimeType: "video/mp4", data: "dmlkZW8=" }],
            timestamp: 1,
          },
        ],
      } satisfies Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false },
    );

    expect(input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "(video omitted: model does not support videos)" }],
      },
    ]);
    expect(JSON.stringify(input)).not.toContain("input_video");
    expect(JSON.stringify(input)).not.toContain("dmlkZW8=");
  });

  it.each([
    {
      protocol: "Codex",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    },
    {
      protocol: "Azure OpenAI",
      api: "azure-openai-responses",
      baseUrl: "https://example.openai.azure.com/openai/v1",
    },
  ] as const)("rejects falsely advertised video on the $protocol protocol", ({ api, baseUrl }) => {
    const misdeclaredModel = {
      ...videoModel,
      api,
      provider: "openai",
      baseUrl,
    } satisfies Model;
    const input = convertResponsesMessages(
      misdeclaredModel,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "video", mimeType: "video/mp4", data: "dmlkZW8=" }],
            timestamp: 1,
          },
          {
            role: "toolResult",
            toolCallId: "call_video",
            toolName: "capture_clip",
            content: [{ type: "video", mimeType: "video/mp4", data: "dmlkZW8=" }],
            isError: false,
            timestamp: 2,
          },
        ],
      } satisfies Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false },
    );

    expect(input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "(video omitted: model does not support videos)" }],
      },
      {
        type: "function_call_output",
        call_id: "call_video",
        output: "(tool video omitted: model does not support videos)",
      },
    ]);
    expect(JSON.stringify(input)).not.toContain("input_video");
    expect(JSON.stringify(input)).not.toContain("dmlkZW8=");
  });

  it("preserves video-capable function outputs without leaking binary into text", () => {
    const input = convertResponsesMessages(
      videoModel,
      {
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_video",
            toolName: "capture_clip",
            content: [
              { type: "text", text: "Captured clip" },
              { type: "video", mimeType: "video/webm", data: "dmlkZW8=" },
            ],
            isError: false,
            timestamp: 1,
          },
        ],
      } satisfies Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false },
    );

    expect(input).toContainEqual({
      type: "function_call_output",
      call_id: "call_video",
      output: [
        { type: "input_text", text: "Captured clip" },
        { type: "input_video", video_url: "data:video/webm;base64,dmlkZW8=" },
      ],
    });
  });

  it("downgrades historical function-output video when the target does not support it", () => {
    const input = convertResponsesMessages(
      baseModel,
      {
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_video",
            toolName: "capture_clip",
            content: [{ type: "video", mimeType: "video/mp4", data: "dmlkZW8=" }],
            isError: false,
            timestamp: 1,
          },
        ],
      } satisfies Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false },
    );

    expect(input).toContainEqual({
      type: "function_call_output",
      call_id: "call_video",
      output: "(tool video omitted: model does not support videos)",
    });
    expect(JSON.stringify(input)).not.toContain("input_video");
  });
});
