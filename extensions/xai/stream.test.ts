import {
  streamSimple,
  type Model,
  type ModelThinkingLevel,
  type ModelRequestHeaders,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { XAI_BASE_URL } from "./model-definitions.js";
import { resolveFastModeSupport } from "./provider-policy-api.js";
import { applyXaiRuntimeModelCompat } from "./runtime-model-compat.js";
import { wrapXaiProviderStream } from "./stream.js";
import { captureXaiRequest, xaiModel } from "./test-helpers.js";

function captureRequest(
  model: Model<"openai-responses">,
  extraParams: Record<string, unknown> = {},
  headers?: ModelRequestHeaders,
  payload?: Record<string, unknown>,
) {
  const captured = captureXaiRequest(model, {
    extraParams: { tool_stream: false, ...extraParams },
    headers,
    payload: payload ?? {},
  });
  return { capturedModelId: captured.modelId, capturedHeaders: captured.headers };
}

function patchPayload<T extends Record<string, unknown>>(
  payload: T,
  model: Partial<Model<"openai-responses">> = {},
): T {
  captureRequest(xaiModel(model), {}, undefined, payload);
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
    captureRequest(xaiModel({ id: modelId }), { fastMode }).capturedModelId;
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
  it("adds the Grok OAuth proxy request contract", () => {
    const id = "grok-4.7";
    const { capturedModelId, capturedHeaders } = captureRequest(
      xaiModel({
        id,
        name: "Subscription default",
        input: ["text"],
        params: { canonicalModelId: "grok-fixture-unselected" },
        baseUrl: "https://cli-chat-proxy.grok.com/v1",
      }),
      {},
      { "X-XAI-Token-Auth": "operator-value", "X-Existing": "kept", "x-delete": null },
    );

    expect(capturedModelId).toBe(id);
    expect(capturedHeaders).toEqual({
      "X-Existing": "kept",
      "x-delete": null,
      "x-grok-client-version": "2026.7.2",
      "x-grok-model-override": id,
      "X-XAI-Token-Auth": "xai-grok-cli",
    });
  });

  it("does not add Grok OAuth headers for a lookalike host", () => {
    const { capturedHeaders } = captureRequest(
      xaiModel({ id: "grok-4.5", baseUrl: "https://cli-chat-proxy.grok.com.example/v1" }),
      {},
      { "X-Existing": "kept" },
    );

    expect(capturedHeaders).toEqual({ "X-Existing": "kept" });
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
      toolOutput(
        [
          inputText("Read image"),
          {
            type: "input_image",
            detail: "auto",
            image_url: "data:image/png;base64,QUJDRA==",
          },
        ],
        callId,
      ),
    ];
    expect(
      project(input, {
        provider: "x-ai",
        baseUrl: ` ${XAI_BASE_URL}/// `,
      }),
    ).toEqual(input);
  });

  it("keeps parallel compatibility image history as a prefix across turns", () => {
    const image = { type: "input_image", image_url: "data:image/png;base64,QUJDRA==" };
    const result = toolOutput([inputText("Read image"), image], "call_image");
    const group = [result, toolOutput("No image", "call_text")];
    const history = [
      { type: "message", role: "user", content: "Read the files" },
      { type: "function_call", call_id: "call_image", name: "read", arguments: "{}" },
      { type: "function_call", call_id: "call_text", name: "read", arguments: "{}" },
      ...group,
    ];
    const first = project(history);
    const nextTurns = [
      { type: "message", role: "assistant", content: "I read the files." },
      { type: "message", role: "user", content: "Read another image" },
      { type: "function_call", call_id: "call_next", name: "read", arguments: "{}" },
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
    const compactedHistory = [
      { type: "message", role: "user", content: "Summary: the first files were read." },
      ...nextTurns,
    ];
    const compacted = project(compactedHistory);
    expect(compacted.at(-1)).toEqual(first.at(-1));
    expect(compacted).toHaveLength(compactedHistory.length + 1);
    expect(
      project([
        ...compactedHistory,
        { type: "message", role: "assistant", content: "The next image is blue." },
        { type: "message", role: "user", content: "Thanks" },
      ]).slice(0, compacted.length),
    ).toEqual(compacted);
  });

  it("replays source-based input_image parts from tool results", () => {
    const image = {
      type: "input_image",
      source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
    };
    expect(project([toolOutput([inputText("Read image"), image])])).toEqual([
      toolOutput("Read image"),
      imageMessage(1, image),
    ]);
  });

  it("preserves interleaved text and image references for image placeholders", () => {
    const firstImage = {
      type: "input_image",
      source: { type: "url", url: "https://example.com/first.png" },
    };
    const secondImage = { type: "input_image", image_url: "data:image/png;base64,QkJCQg==" };
    const originalParts = [inputText(""), firstImage, inputText(""), secondImage];
    const originalBytes = JSON.stringify(originalParts);
    const payload = {
      input: [toolOutput(originalParts, "call_1")],
    };
    patchPayload(payload);

    const input = payload.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual(toolOutput("(see attached image)"));
    expect(input[1]).toEqual(imageMessage(1, firstImage, secondImage));
    const replayParts = input[1]?.content as unknown[];
    expect(replayParts[1]).toBe(firstImage);
    expect(replayParts[2]).toBe(secondImage);
    expect(JSON.stringify(originalParts)).toBe(originalBytes);
  });

  it("counts every function output before replaying sparse images for the Grok OAuth proxy", () => {
    const callIds = [
      "x".repeat(64) + "a",
      "a".repeat(63) + "🙈",
      ...["c", "d"].map((suffix) => `${"x".repeat(64)}${suffix}`),
    ];
    const firstImage = {
      type: "input_image",
      detail: "auto",
      image_url: "data:image/png;base64,QUFBQQ==",
    };
    const secondImage = { ...firstImage, image_url: "data:image/png;base64,QkJCQg==" };
    const input = [
      { type: "message", role: "user", content: "Read the tool results" },
      toolOutput("No image", callIds[0]),
      toolOutput([inputText("first"), structuredClone(firstImage)], callIds[1]),
      toolOutput([inputText("Still no image")], callIds[2]),
      toolOutput([inputText("second"), structuredClone(secondImage)], callIds[3]),
    ];
    expect(project(input, { baseUrl: "https://cli-chat-proxy.grok.com/v1" })).toEqual([
      { type: "message", role: "user", content: "Read the tool results" },
      toolOutput("No image", callIds[0]),
      toolOutput("first", callIds[1]),
      toolOutput("Still no image", callIds[2]),
      toolOutput("second", callIds[3]),
      imageMessage(2, firstImage, inputText("Image(s) from tool result #4:"), secondImage),
    ]);
  });

  it.each([
    [
      "image",
      { type: "input_image", detail: "auto", image_url: "data:image/png;base64,QUJDRA==" },
      "call_1",
    ],
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
