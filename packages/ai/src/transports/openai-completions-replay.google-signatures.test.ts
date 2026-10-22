import { describe, expect, it } from "vitest";
import type { Model } from "../types.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import { streamFixture } from "./openai-completions-suite.test-support.js";
import {
  createAssistantOutput,
  expectRecordFields,
  getAssistantMessage,
  makeCompletionsChunk,
  makeCompletionsModel,
} from "./openai-completions.test-support.js";

function geminiToolReplayContext(
  model: Model<"openai-completions">,
  options: {
    sourceApi?: string;
    thoughtSignature?: string;
    arguments?: unknown;
    includeUserAndResult?: boolean;
  } = {},
) {
  const assistant = {
    ...createAssistantOutput(model),
    api: options.sourceApi ?? model.api,
    stopReason: "toolUse",
    timestamp: 1,
    content: [
      {
        type: "toolCall",
        id: "call_abc",
        name: "echo_value",
        arguments: options.arguments ?? {},
        ...(options.thoughtSignature ? { thoughtSignature: options.thoughtSignature } : {}),
      },
    ],
  };
  return {
    messages: options.includeUserAndResult
      ? [
          { role: "user", content: "echo" },
          assistant,
          {
            role: "toolResult",
            toolCallId: "call_abc",
            toolName: "echo_value",
            content: [{ type: "text", text: "ok" }],
            isError: false,
          },
        ]
      : [assistant],
    tools: [{ name: "echo_value", description: "Echo", parameters: { type: "object" } }],
  } as never;
}

function replayedTool(
  model: Model<"openai-completions">,
  options?: Parameters<typeof geminiToolReplayContext>[1],
) {
  const assistant = getAssistantMessage(
    buildOpenAICompletionsParams(model, geminiToolReplayContext(model, options), undefined),
  ) as { tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> };
  return assistant.tool_calls?.[0]?.extra_content;
}

async function expectStreamedSignature(
  model: Model<"openai-completions">,
  chunks: readonly unknown[],
  thoughtSignature: string,
) {
  const { output, run } = streamFixture(model);
  await run(chunks);
  expectRecordFields(output.content[0], {
    type: "toolCall",
    id: "call_abc",
    name: "echo_value",
    arguments: { value: "repro" },
    thoughtSignature,
  });
}

describe("Gemini thought_signature round-trip on OpenAI-compatible completions", () => {
  const geminiModel = makeCompletionsModel({
    id: "gemini-3-flash-preview",

    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  });

  it.each([false, true])("captures streamed signatures (top-level=%s)", async (topLevel) => {
    const model = topLevel
      ? makeCompletionsModel({
          id: "gemini-3-6-flash",
          provider: "venice",
          baseUrl: "https://api.venice.ai/api/v1",
        })
      : geminiModel;
    const signature = topLevel ? "SIG-VENICE-OPAQUE-ABC==" : "SIG-OPAQUE-ABC==";
    await expectStreamedSignature(
      model,
      [
        makeCompletionsChunk({
          tool_calls: [
            {
              index: 0,
              id: "call_abc",
              type: "function",
              function: { name: "echo_value", arguments: topLevel ? '{"value":"repro"}' : "" },
              ...(topLevel
                ? { thought_signature: signature }
                : { extra_content: { google: { thought_signature: signature } } }),
            },
          ],
        }),
        makeCompletionsChunk(
          topLevel
            ? {}
            : { tool_calls: [{ index: 0, function: { arguments: '{"value":"repro"}' } }] },
          "tool_calls",
        ),
      ],
      signature,
    );
  });

  it("re-emits captured thought_signature for same Google route tool-call replay", () => {
    const extra = replayedTool(geminiModel, {
      thoughtSignature: "SIG-OPAQUE-ABC==",
      arguments: { value: "repro" },
      includeUserAndResult: true,
    });
    expect(extra?.google?.thought_signature).toBe("SIG-OPAQUE-ABC==");
  });

  it("uses the Gemini skip-validator signature across a different API surface", () => {
    const extra = replayedTool(geminiModel, {
      sourceApi: "google-generative-ai",
      thoughtSignature: "SIG-OPAQUE-ABC==",
      arguments: { value: "repro" },
    });
    expect(extra?.google?.thought_signature).toBe("skip_thought_signature_validator");
  });

  it.each(["gemini-3-flash-preview", "gemini-3.8-flash", "gemini-4-argon"])(
    "uses the skip-validator signature for unsigned %s replay",
    (id) => {
      const target = { ...geminiModel, id };
      const extra = replayedTool(target);
      expect(extra?.google?.thought_signature).toBe("skip_thought_signature_validator");
    },
  );

  it("drops the field when the model is not Gemini 3 and the captured same-route signature is truncated", () => {
    const nonGemini3Model = { ...geminiModel, id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" };
    const extra = replayedTool(nonGemini3Model, {
      arguments: { value: "repro" },
      thoughtSignature:
        "CmcBjz1rX55U6JcpC2oZVTk40Kx6nVK8LKzbl61rOFztcvSdL7pdIvBEDyJLRqWrPVpdD+rj3GsJ3f9PG6b2Ry2UnK38+dInfGIlJbXHt++EC",
    });
    expect(extra?.google?.thought_signature).toBeUndefined();
  });

  it("does not trust cross-route thought_signature for non-Gemini-3 Google compat models", () => {
    const nonGemini3Model = { ...geminiModel, id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" };
    const extra = replayedTool(nonGemini3Model, {
      sourceApi: "google-generative-ai",
      thoughtSignature: "SIG-OPAQUE-ABC==",
      arguments: { value: "repro" },
    });
    expect(extra).toBeUndefined();
  });
});
