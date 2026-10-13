// Xai tests cover stream plugin behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  streamSimple,
  type Api,
  type Context,
  type Model,
  type ModelThinkingLevel,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { XAI_BASE_URL } from "./model-definitions.js";
import { resolveFastModeSupport } from "./provider-policy-api.js";
import { applyXaiRuntimeModelCompat } from "./runtime-model-compat.js";
import { wrapXaiProviderStream } from "./stream.js";
type XaiStreamApi = Extract<Api, "openai-completions" | "openai-responses">;

function captureWrappedModelId(params: {
  modelId: string;
  fastMode: boolean | "ultrafast" | (() => boolean | "ultrafast" | undefined);
  api?: XaiStreamApi;
  provider?: string;
}): string {
  let capturedModelId = "";
  const baseStreamFn: StreamFn = (model) => {
    capturedModelId = model.id;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = wrapXaiProviderStream({
    streamFn: baseStreamFn,
    extraParams: { fastMode: params.fastMode, tool_stream: false },
  } as never);
  void wrapped?.(
    {
      api: params.api ?? "openai-responses",
      provider: params.provider ?? "xai",
      id: params.modelId,
    } as Model<Extract<Api, "openai-completions" | "openai-responses">>,
    { messages: [] } as Context,
    {},
  );

  return capturedModelId;
}

function runXaiToolPayloadWrapper(params: {
  payload: Record<string, unknown>;
  api?: XaiStreamApi;
  modelId?: string;
  input?: string[];
  provider?: string;
  baseUrl?: string;
}) {
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(params.payload, {} as Model<XaiStreamApi>);
    return {} as ReturnType<StreamFn>;
  };
  const wrapped = wrapXaiProviderStream({
    streamFn: baseStreamFn,
    extraParams: { tool_stream: false },
  } as never);
  const api = params.api ?? "openai-responses";

  void wrapped?.(
    {
      api,
      provider: params.provider ?? "xai",
      baseUrl: params.baseUrl ?? "https://proxy.example/v1",
      id:
        params.modelId ??
        (api === "openai-completions" ? "grok-4-1-fast-reasoning" : "grok-4-fast"),
      reasoning: params.modelId ? !params.modelId.includes("non-reasoning") : true,
      ...(params.input ? { input: params.input } : {}),
    } as Model<XaiStreamApi>,
    { messages: [] } as Context,
    {},
  );
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
  expect(captureWrappedModelId({ modelId, fastMode: true })).toBe(target);
  expect(captureWrappedModelId({ modelId, fastMode: "ultrafast" })).toBe(target);
  expect(captureWrappedModelId({ modelId, fastMode: () => "ultrafast" })).toBe(target);
  expect(captureWrappedModelId({ modelId, fastMode: false })).toBe(modelId);
});

async function captureXaiResponsesPayloadWithThinking(
  reasoning: ModelThinkingLevel = "low",
  modelId = "grok-4.5",
): Promise<Record<string, unknown>> {
  const model = applyXaiRuntimeModelCompat({
    api: "openai-responses",
    provider: "xai",
    id: modelId,
    baseUrl: "https://api.x.ai/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 6,
      cacheRead: modelId === "grok-4.5" ? 0.3 : 0.5,
      cacheWrite: 0,
    },
    contextWindow: 500_000,
    maxTokens: 64_000,
  } as Model<"openai-responses">);
  const wrapped = wrapXaiProviderStream({
    provider: "xai",
    modelId,
    model,
    streamFn: streamSimple,
  });
  if (!wrapped) {
    throw new Error("expected the xAI stream wrapper");
  }

  const payloadPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const stream = wrapped(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      {
        apiKey: "test-api-key",
        cacheRetention: "none",
        reasoning,
        onPayload: (payload) => {
          resolve(structuredClone(payload as Record<string, unknown>));
          throw new Error("stop after payload capture");
        },
      },
    );
    void Promise.resolve(stream)
      .then((result) => result.result())
      .then(
        () => reject(new Error("provider payload callback was not invoked")),
        (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
      );
  });

  return await payloadPromise;
}

describe("xai stream wrappers", () => {
  it.each([{ id: "grok-4.7", baseUrl: "https://cli-chat-proxy.grok.com/v1" }])(
    "adds the Grok OAuth proxy request contract for $id at $baseUrl",
    ({ id, baseUrl }) => {
      let capturedHeaders: Record<string, string> | undefined;
      let capturedModelId: string | undefined;
      const baseStreamFn: StreamFn = (model, _context, options) => {
        capturedModelId = model.id;
        capturedHeaders = options?.headers;
        return {} as ReturnType<StreamFn>;
      };
      const wrapped = wrapXaiProviderStream(
        {
          streamFn: baseStreamFn,
          extraParams: { tool_stream: false },
        } as never,
        { clientVersion: "2026.7.2" },
      );

      void wrapped?.(
        {
          api: "openai-responses",
          provider: "xai",
          id,
          name: "Subscription default",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 500_000,
          maxTokens: 64_000,
          params: { canonicalModelId: "grok-fixture-unselected" },
          baseUrl,
        },
        { messages: [] },
        { headers: { "X-XAI-Token-Auth": "operator-value", "X-Existing": "kept" } },
      );

      expect(capturedModelId).toBe(id);
      expect(capturedHeaders).toEqual({
        "x-existing": "kept",
        "x-grok-client-version": "2026.7.2",
        "x-grok-model-override": id,
        "x-xai-token-auth": "xai-grok-cli",
      });
    },
  );

  it.each([["a lookalike host", "xai", "https://cli-chat-proxy.grok.com.example/v1"]])(
    "does not add Grok OAuth headers for %s",
    (_label, provider, baseUrl) => {
      let capturedHeaders: Record<string, string> | undefined;
      const baseStreamFn: StreamFn = (_model, _context, options) => {
        capturedHeaders = options?.headers;
        return {} as ReturnType<StreamFn>;
      };
      const wrapped = wrapXaiProviderStream(
        {
          streamFn: baseStreamFn,
          extraParams: { tool_stream: false },
        } as never,
        { clientVersion: "2026.7.2" },
      );

      void wrapped?.(
        {
          api: "openai-responses",
          provider,
          id: "grok-4.5",
          baseUrl,
        } as Model<"openai-responses">,
        { messages: [] } as Context,
        { headers: { "X-Existing": "kept" } },
      );

      expect(capturedHeaders).toEqual({ "X-Existing": "kept" });
    },
  );

  it("strips unsupported reasoning controls from non-reasoning xai payloads", () => {
    const payload: Record<string, unknown> = {
      reasoning: { effort: "high" },
      reasoningEffort: "high",
      reasoning_effort: "high",
    };
    runXaiToolPayloadWrapper({ payload, modelId: "grok-4-fast-non-reasoning" });

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoningEffort");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("merges encrypted reasoning include with existing include entries", () => {
    const payload: Record<string, unknown> = {
      include: ["file_search_call.results"],
    };
    runXaiToolPayloadWrapper({
      payload,
      modelId: "grok-build-0.1",
    });

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

  it.each([["x-ai", ` ${XAI_BASE_URL}/// `]])(
    "preserves native Responses image output arrays for %s",
    (provider, baseUrl) => {
      const callId = `${"a".repeat(63)}🙈`;
      const input = [
        {
          type: "function_call_output",
          call_id: callId,
          output: [
            { type: "input_text", text: "Read image" },
            {
              type: "input_image",
              detail: "auto",
              image_url: "data:image/png;base64,QUJDRA==",
            },
          ],
        },
      ];
      const payload: Record<string, unknown> = { input: structuredClone(input) };
      runXaiToolPayloadWrapper({ payload, input: ["text", "image"], provider, baseUrl });

      expect(payload.input).toEqual(input);
    },
  );

  it.each([true])(
    "keeps compatibility image history as a prefix across turns (parallel: %s)",
    (parallel) => {
      const image = { type: "input_image", image_url: "data:image/png;base64,QUJDRA==" };
      const result = {
        type: "function_call_output",
        call_id: "call_image",
        output: [{ type: "input_text", text: "Read image" }, image],
      };
      const group = [
        result,
        ...(parallel
          ? [{ type: "function_call_output", call_id: "call_text", output: "No image" }]
          : []),
      ];
      const history = [
        { type: "message", role: "user", content: "Read the files" },
        { type: "function_call", call_id: "call_image", name: "read", arguments: "{}" },
        ...(parallel
          ? [{ type: "function_call", call_id: "call_text", name: "read", arguments: "{}" }]
          : []),
        ...group,
      ];
      const project = (input: Array<Record<string, unknown>>) => {
        const payload = { input: structuredClone(input) };
        runXaiToolPayloadWrapper({ payload, input: ["text", "image"] });
        return payload.input;
      };
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
        ...(parallel ? [group[1]] : []),
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Image(s) from tool result #1:" }, image],
        },
      ]);
      expect(next.at(-1)).toEqual({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: `Image(s) from tool result #${group.length + 1}:` },
          image,
        ],
      });
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
    },
  );

  it("replays source-based input_image parts from tool results", () => {
    const payload: Record<string, unknown> = {
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            { type: "input_text", text: "Read image" },
            {
              type: "input_image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "QUJDRA==",
              },
            },
          ],
        },
      ],
    };
    runXaiToolPayloadWrapper({ payload, input: ["text", "image"] });

    expect(payload.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "Read image",
      },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Image(s) from tool result #1:" },
          {
            type: "input_image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "QUJDRA==",
            },
          },
        ],
      },
    ]);
  });

  it.each([{ text: ["", ""], output: "(see attached image)" }])(
    "preserves interleaved text and image references for $output",
    ({ text, output }) => {
      const firstImage = {
        type: "input_image",
        source: { type: "url", url: "https://example.com/first.png" },
      };
      const secondImage = { type: "input_image", image_url: "data:image/png;base64,QkJCQg==" };
      const originalParts = [
        { type: "input_text", text: text[0] },
        firstImage,
        { type: "input_text", text: text[1] },
        secondImage,
      ];
      const originalBytes = JSON.stringify(originalParts);
      const payload: Record<string, unknown> = {
        input: [{ type: "function_call_output", call_id: "call_1", output: originalParts }],
      };
      runXaiToolPayloadWrapper({ payload, input: ["text", "image"] });

      const input = payload.input as Array<Record<string, unknown>>;
      expect(input[0]).toEqual({ type: "function_call_output", call_id: "call_1", output });
      expect(input[1]).toEqual({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Image(s) from tool result #1:" },
          firstImage,
          secondImage,
        ],
      });
      const replayParts = input[1]?.content as unknown[];
      expect(replayParts[1]).toBe(firstImage);
      expect(replayParts[2]).toBe(secondImage);
      expect(JSON.stringify(originalParts)).toBe(originalBytes);
    },
  );

  it.each([["Grok OAuth proxy", "https://cli-chat-proxy.grok.com/v1"]])(
    "counts every function output before replaying sparse images for %s",
    (_label, baseUrl) => {
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
      const payload: Record<string, unknown> = {
        input: [
          { type: "message", role: "user", content: "Read the tool results" },
          { type: "function_call_output", call_id: callIds[0], output: "No image" },
          {
            type: "function_call_output",
            call_id: callIds[1],
            output: [{ type: "input_text", text: "first" }, structuredClone(firstImage)],
          },
          {
            type: "function_call_output",
            call_id: callIds[2],
            output: [{ type: "input_text", text: "Still no image" }],
          },
          {
            type: "function_call_output",
            call_id: callIds[3],
            output: [{ type: "input_text", text: "second" }, structuredClone(secondImage)],
          },
        ],
      };
      runXaiToolPayloadWrapper({ payload, input: ["text", "image"], baseUrl });

      expect(payload.input).toEqual([
        { type: "message", role: "user", content: "Read the tool results" },
        { type: "function_call_output", call_id: callIds[0], output: "No image" },
        { type: "function_call_output", call_id: callIds[1], output: "first" },
        { type: "function_call_output", call_id: callIds[2], output: "Still no image" },
        { type: "function_call_output", call_id: callIds[3], output: "second" },
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Image(s) from tool result #2:" },
            firstImage,
            { type: "input_text", text: "Image(s) from tool result #4:" },
            secondImage,
          ],
        },
      ]);
    },
  );

  it("drops image blocks and uses fallback text for models without image input", () => {
    const payload: Record<string, unknown> = {
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            {
              type: "input_image",
              detail: "auto",
              image_url: "data:image/png;base64,QUJDRA==",
            },
          ],
        },
      ],
    };
    runXaiToolPayloadWrapper({ payload, input: ["text"] });

    expect(payload.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "(see attached image)",
      },
    ]);
  });

  it("uses audio fallback text for audio-only tool outputs", () => {
    const payload: Record<string, unknown> = {
      input: [
        {
          type: "function_call_output",
          call_id: "call_audio",
          output: [
            {
              type: "input_audio",
              mimeType: "audio/wav",
              data: "QUJDRA==",
            },
          ],
        },
      ],
    };
    runXaiToolPayloadWrapper({ payload, input: ["text"] });

    expect(payload.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_audio",
        output: "(see attached audio)",
      },
    ]);
  });
});
