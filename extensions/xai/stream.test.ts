import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { streamSimpleOpenAIResponses } from "@mariozechner/pi-ai/openai-responses";
import { describe, expect, it } from "vitest";
import { applyXaiRuntimeModelCompat } from "./runtime-model-compat.js";
import {
  createXaiFastModeWrapper,
  createXaiToolPayloadCompatibilityWrapper,
  wrapXaiProviderStream,
} from "./stream.js";
import {
  createXaiPayloadCaptureStream,
  expectXaiFastToolStreamShaping,
  runXaiGrok4ResponseStream,
} from "./test-helpers.js";
type XaiStreamApi = Extract<Api, "openai-completions" | "openai-responses">;

function captureWrappedModelId(params: {
  modelId: string;
  fastMode: boolean;
  api?: XaiStreamApi;
}): string {
  let capturedModelId = "";
  const baseStreamFn: StreamFn = (model) => {
    capturedModelId = model.id;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createXaiFastModeWrapper(baseStreamFn, params.fastMode);
  void wrapped(
    {
      api: params.api ?? "openai-responses",
      provider: "xai",
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
  reasoning?: boolean;
}) {
  const baseStreamFn: StreamFn = (model, _context, options) => {
    options?.onPayload?.(params.payload, model as Model<XaiStreamApi>);
    return {} as ReturnType<StreamFn>;
  };
  const wrapped = createXaiToolPayloadCompatibilityWrapper(baseStreamFn);
  const api = params.api ?? "openai-responses";

  void wrapped(
    {
      api,
      provider: "xai",
      id:
        params.modelId ??
        (api === "openai-completions" ? "grok-4-1-fast-reasoning" : "grok-4-fast"),
      ...(params.reasoning !== undefined ? { reasoning: params.reasoning } : {}),
      ...(params.input ? { input: params.input } : {}),
    } as Model<XaiStreamApi>,
    { messages: [] } as Context,
    {},
  );
}

async function captureXaiResponsesPayloadWithThinking(): Promise<Record<string, unknown>> {
  const model = applyXaiRuntimeModelCompat({
    api: "openai-responses",
    provider: "xai",
    id: "grok-4.3",
    baseUrl: "https://api.x.ai/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  } as Model<"openai-responses">);

  const payloadPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("provider payload callback was not invoked")),
      1_000,
    );
    const stream = streamSimpleOpenAIResponses(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      {
        apiKey: "test-api-key",
        cacheRetention: "none",
        reasoning: "low",
        onPayload: (payload) => {
          clearTimeout(timeout);
          resolve(structuredClone(payload as Record<string, unknown>));
          throw new Error("stop after payload capture");
        },
      },
    );
    void stream.result();
  });

  return await payloadPromise;
}

describe("xai stream wrappers", () => {
  it("rewrites supported Grok models to fast variants when fast mode is enabled", () => {
    expect(captureWrappedModelId({ modelId: "grok-3", fastMode: true })).toBe("grok-3-fast");
    expect(
      captureWrappedModelId({
        modelId: "grok-3",
        fastMode: true,
        api: "openai-completions",
      }),
    ).toBe("grok-3-fast");
    expect(captureWrappedModelId({ modelId: "grok-4", fastMode: true })).toBe("grok-4-fast");
    expect(
      captureWrappedModelId({
        modelId: "grok-3",
        fastMode: true,
        api: "openai-responses",
      }),
    ).toBe("grok-3-fast");
  });

  it("leaves unsupported or disabled models unchanged", () => {
    expect(captureWrappedModelId({ modelId: "grok-3-fast", fastMode: true })).toBe("grok-3-fast");
    expect(captureWrappedModelId({ modelId: "grok-3", fastMode: false })).toBe("grok-3");
  });

  it("composes the xai provider stream chain from extra params", () => {
    const capture = createXaiPayloadCaptureStream();

    const wrapped = wrapXaiProviderStream({
      streamFn: capture.streamFn,
      extraParams: { fastMode: true },
    } as never);

    runXaiGrok4ResponseStream(wrapped);
    expectXaiFastToolStreamShaping(capture);
  });

  it("strips unsupported strict flag and reasoning controls from non-reasoning tool payloads", () => {
    const payload = {
      reasoning: "high",
      reasoningEffort: "high",
      reasoning_effort: "high",
      tools: [
        {
          type: "function",
          function: {
            name: "write",
            parameters: { type: "object", properties: {} },
            strict: true,
          },
        },
      ],
    };
    runXaiToolPayloadWrapper({
      payload,
      api: "openai-completions",
      modelId: "grok-3",
      reasoning: false,
    });

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoningEffort");
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload.tools[0]?.function).not.toHaveProperty("strict");
  });

  it("strips reasoning controls from xai payloads when the model does not support reasoning", () => {
    const payload: Record<string, unknown> = {
      reasoning: { effort: "high" },
      reasoningEffort: "high",
      reasoning_effort: "high",
    };
    runXaiToolPayloadWrapper({
      payload,
      modelId: "grok-4-fast",
      reasoning: false,
    });

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoningEffort");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("forwards reasoning controls on reasoning-capable Grok models", () => {
    const payload: Record<string, unknown> = {
      reasoning: { effort: "high" },
      reasoning_effort: "high",
    };
    runXaiToolPayloadWrapper({
      payload,
      modelId: "grok-4.3",
      reasoning: true,
    });

    expect(payload.reasoning).toEqual({ effort: "high" });
    expect(payload.reasoning_effort).toBe("high");
  });

  it("forwards reasoning_effort for grok-4-1-fast-reasoning over openai-completions", () => {
    const payload: Record<string, unknown> = {
      reasoning_effort: "low",
    };
    runXaiToolPayloadWrapper({
      payload,
      api: "openai-completions",
      modelId: "grok-4-1-fast-reasoning",
      reasoning: true,
    });

    expect(payload.reasoning_effort).toBe("low");
  });

  it("forwards native xAI Responses reasoning effort to pi-ai payload builders", async () => {
    const payload = await captureXaiResponsesPayloadWithThinking();

    expect(payload).toHaveProperty("reasoning");
    expect((payload as { reasoning: { effort: string } }).reasoning.effort).toBe("low");
    // pi-ai's openai-responses path attaches encrypted reasoning content to
    // include[] when reasoning is enabled. Asserting its presence here keeps
    // us honest that we're producing a real reasoning request, not just an
    // empty stub.
    expect(payload).toHaveProperty("include");
  });

  it("moves image-bearing tool results out of function_call_output payloads", () => {
    const payload: Record<string, unknown> = {
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            { type: "input_text", text: "Read image" },
            {
              type: "input_image",
              detail: "auto",
              image_url: "data:image/png;base64,QUJDRA==",
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
          { type: "input_text", text: "Attached image(s) from tool result:" },
          {
            type: "input_image",
            detail: "auto",
            image_url: "data:image/png;base64,QUJDRA==",
          },
        ],
      },
    ]);
  });

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
          { type: "input_text", text: "Attached image(s) from tool result:" },
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

  it("keeps multiple tool outputs contiguous before replaying collected images", () => {
    const payload: Record<string, unknown> = {
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            { type: "input_text", text: "first" },
            {
              type: "input_image",
              detail: "auto",
              image_url: "data:image/png;base64,QUFBQQ==",
            },
          ],
        },
        {
          type: "function_call_output",
          call_id: "call_2",
          output: [
            { type: "input_text", text: "second" },
            {
              type: "input_image",
              detail: "auto",
              image_url: "data:image/png;base64,QkJCQg==",
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
        output: "first",
      },
      {
        type: "function_call_output",
        call_id: "call_2",
        output: "second",
      },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Attached image(s) from tool result:" },
          {
            type: "input_image",
            detail: "auto",
            image_url: "data:image/png;base64,QUFBQQ==",
          },
          {
            type: "input_image",
            detail: "auto",
            image_url: "data:image/png;base64,QkJCQg==",
          },
        ],
      },
    ]);
  });

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
});
