import { streamSimple, type Model, type ModelThinkingLevel } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { XAI_BASE_URL } from "./model-definitions.js";
import { resolveFastModeSupport } from "./provider-policy-api.js";
import { applyXaiRuntimeModelCompat } from "./runtime-model-compat.js";
import { wrapXaiProviderStream } from "./stream.js";
import { captureXaiRequest, xaiModel } from "./test-helpers.js";

function patchPayload<T extends Record<string, unknown>>(
  payload: T,
  model: Partial<Model<"openai-responses">> = {},
): T {
  captureXaiRequest(xaiModel(model), { extraParams: { tool_stream: false }, payload });
  return payload;
}

function project(
  input: Array<Record<string, unknown>>,
  model: Partial<Model<"openai-responses">> = {},
) {
  return patchPayload({ input: structuredClone(input) }, model).input;
}

function toolOutput(output: unknown, callId = "call_1") {
  return { type: "function_call_output", call_id: callId, output };
}

function inputText(text: string) {
  return { type: "input_text", text };
}

function imageMessage(index: number, ...images: unknown[]) {
  return {
    type: "message",
    role: "user",
    content: [inputText(`Image(s) from tool result #${index}:`), ...images],
  };
}

function message(role: string, content: string) {
  return { type: "message", role, content };
}

function toolCall(call_id: string) {
  return { type: "function_call", call_id, name: "read", arguments: "{}" };
}

function imagePart(image_url = "data:image/png;base64,QUJDRA==") {
  return { type: "input_image", image_url };
}

it.each([
  { modelId: "grok-4-0709", target: "grok-4-fast", supported: true },
  { modelId: "grok-4.3", target: "grok-4.3", supported: false },
])("publishes the actual Fast mapping for $modelId", ({ modelId, target, supported }) => {
  expect(
    resolveFastModeSupport({
      modelId,
      provider: "xai",
      api: "openai-responses",
      runtimeId: "openclaw",
      requestCapabilities: { endpointClass: "xai-native", allowsAnthropicServiceTier: false },
    }),
  ).toBe(supported);
  const capture = (fastMode: boolean | "ultrafast" | (() => "ultrafast")) =>
    captureXaiRequest(xaiModel({ id: modelId }), { extraParams: { tool_stream: false, fastMode } })
      .modelId;
  expect([capture(true), capture("ultrafast"), capture(() => "ultrafast"), capture(false)]).toEqual(
    [target, target, target, modelId],
  );
});

async function captureXaiResponsesPayloadWithThinking(
  reasoning: ModelThinkingLevel,
  modelId: string,
): Promise<Record<string, unknown>> {
  const model = applyXaiRuntimeModelCompat(xaiModel({ id: modelId, baseUrl: XAI_BASE_URL }));
  const wrapped = wrapXaiProviderStream({
    provider: "xai",
    modelId,
    model,
    streamFn: streamSimple,
  });
  if (!wrapped) {
    throw new Error("expected the xAI stream wrapper");
  }

  let captured: Record<string, unknown> | undefined;
  const stream = await wrapped(
    model,
    { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    {
      apiKey: "test-api-key",
      cacheRetention: "none",
      reasoning,
      onPayload: (payload) => {
        captured = structuredClone(payload as Record<string, unknown>);
        throw new Error("stop after payload capture");
      },
    },
  );
  await stream.result();
  if (!captured) {
    throw new Error("provider payload callback was not invoked");
  }
  return captured;
}

describe("xai stream wrappers", () => {
  it("does not add Grok OAuth headers for a lookalike host", () => {
    const { headers } = captureXaiRequest(
      xaiModel({ id: "grok-4.5", baseUrl: "https://cli-chat-proxy.grok.com.example/v1" }),
      { extraParams: { tool_stream: false }, headers: { "X-Existing": "kept" } },
    );
    expect(headers).toEqual({ "X-Existing": "kept" });
  });

  it("strips unsupported reasoning controls from non-reasoning xai payloads", () => {
    const payload: Record<string, unknown> = {
      reasoning: { effort: "high" },
      reasoningEffort: "high",
      reasoning_effort: "high",
    };
    patchPayload(payload, { id: "grok-4-fast-non-reasoning", reasoning: false });

    expect(payload).toEqual({});
  });

  it("merges encrypted reasoning include with existing include entries", () => {
    const payload: Record<string, unknown> = {
      include: ["file_search_call.results"],
    };
    patchPayload(payload, { id: "grok-build-0.1" });

    expect(payload.include).toEqual(["file_search_call.results", "reasoning.encrypted_content"]);
  });

  it.each([
    ["grok-4.7", "xhigh", { effort: "xhigh", summary: "auto" }],
    ["grok-4.3", "off", { effort: "none" }],
    ["grok-4.20-0309-reasoning", "off", undefined],
  ] as const)(
    "preserves %s %s at the final xAI Responses payload boundary",
    async (modelId, thinking, expectedReasoning) => {
      const payload = await captureXaiResponsesPayloadWithThinking(thinking, modelId);

      expect(payload.reasoning).toEqual(expectedReasoning);
      expect(payload.include).toEqual(["reasoning.encrypted_content"]);
    },
    10_000,
  );

  it("preserves native Responses image output arrays for x-ai", () => {
    const callId = `${"a".repeat(63)}🙈`;
    const input = [
      toolOutput([inputText("Read image"), { ...imagePart(), detail: "auto" }], callId),
    ];
    expect(
      project(input, {
        provider: "x-ai",
        baseUrl: ` ${XAI_BASE_URL}/// `,
      }),
    ).toEqual(input);
  });

  it("keeps parallel compatibility image history as a prefix across turns", () => {
    const image = {
      type: "input_image",
      source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
    };
    const result = toolOutput([inputText("Read image"), image], "call_image");
    const group = [result, toolOutput("No image", "call_text")];
    const history = [
      message("user", "Read the files"),
      toolCall("call_image"),
      toolCall("call_text"),
      ...group,
    ];
    const first = project(history);
    const nextTurns = [
      message("assistant", "I read the files."),
      message("user", "Read another image"),
      toolCall("call_next"),
      { ...result, call_id: "call_next" },
    ];
    const next = project([...history, ...nextTurns]);

    // Compare the actual serialized message prefix, including the image bytes.
    expect(JSON.stringify(next.slice(0, first.length))).toBe(JSON.stringify(first));
    expect(first.slice(-group.length - 1)).toEqual([
      { ...result, output: "Read image" },
      group[1],
      imageMessage(1, image),
    ]);
    expect(next.at(-1)).toEqual(imageMessage(group.length + 1, image));
    expect(project(next)).toEqual(next);

    // Compaction replaces old history; the retained tail establishes a fresh prefix.
    const compactedHistory = [message("user", "Summary: the first files were read."), ...nextTurns];
    const compacted = project(compactedHistory);
    expect(compacted.at(-1)).toEqual(first.at(-1));
    expect(compacted).toHaveLength(compactedHistory.length + 1);
    expect(
      project([
        ...compactedHistory,
        message("assistant", "The next image is blue."),
        message("user", "Thanks"),
      ]).slice(0, compacted.length),
    ).toEqual(compacted);
  });

  it("preserves interleaved text and image references for image placeholders", () => {
    const firstImage = {
      type: "input_image",
      source: { type: "url", url: "https://example.com/first.png" },
    };
    const secondImage = imagePart("data:image/png;base64,QkJCQg==");
    const originalParts = [inputText(""), firstImage, inputText(""), secondImage];
    const originalBytes = JSON.stringify(originalParts);
    const payload = {
      input: [toolOutput(originalParts, "call_1")],
    };
    patchPayload(payload);

    const input = payload.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual(toolOutput("(see attached image)"));
    expect(input[1]).toEqual(imageMessage(1, firstImage, secondImage));
    expect(JSON.stringify(originalParts)).toBe(originalBytes);
  });

  it("counts every function output before replaying sparse images for the Grok OAuth proxy", () => {
    const callIds = [
      "x".repeat(64) + "a",
      "a".repeat(63) + "🙈",
      ...["c", "d"].map((suffix) => `${"x".repeat(64)}${suffix}`),
    ];
    const firstImage = { ...imagePart("data:image/png;base64,QUFBQQ=="), detail: "auto" };
    const secondImage = { ...firstImage, image_url: "data:image/png;base64,QkJCQg==" };
    const input = [
      message("user", "Read the tool results"),
      toolOutput("No image", callIds[0]),
      toolOutput([inputText("first"), structuredClone(firstImage)], callIds[1]),
      toolOutput([inputText("Still no image")], callIds[2]),
      toolOutput([inputText("second"), structuredClone(secondImage)], callIds[3]),
    ];
    expect(project(input, { baseUrl: "https://cli-chat-proxy.grok.com/v1" })).toEqual([
      message("user", "Read the tool results"),
      toolOutput("No image", callIds[0]),
      toolOutput("first", callIds[1]),
      toolOutput("Still no image", callIds[2]),
      toolOutput("second", callIds[3]),
      imageMessage(2, firstImage, inputText("Image(s) from tool result #4:"), secondImage),
    ]);
  });

  it.each([
    ["image", { ...imagePart(), detail: "auto" }, "call_1"],
    ["audio", { type: "input_audio", mimeType: "audio/wav", data: "QUJDRA==" }, "call_audio"],
  ] as const)(
    "uses %s fallback text without forwarding unsupported media",
    (kind, part, callId) => {
      expect(project([toolOutput([part], callId)], { input: ["text"] })).toEqual([
        toolOutput(`(see attached ${kind})`, callId),
      ]);
    },
  );
});
