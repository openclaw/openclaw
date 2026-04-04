import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createXaiFastModeWrapper,
  createXaiToolPayloadCompatibilityWrapper,
  wrapXaiProviderStream,
} from "./stream.js";

type ToolPayload = {
  function?: Record<string, unknown>;
};

function captureWrappedModelId(params: {
  modelId: string;
  fastMode: boolean;
  api?: Extract<Api, "openai-completions" | "openai-responses">;
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
    let capturedModelId = "";
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (model, _context, options) => {
      capturedModelId = String(model.id);
      const payload: Record<string, unknown> = {
        reasoning: { effort: "high" },
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
      options?.onPayload?.(payload as never, model as never);
      capturedPayload = payload;
      return {
        result: async () => ({}) as never,
        async *[Symbol.asyncIterator]() {},
      } as unknown as ReturnType<StreamFn>;
    };

    const wrapped = wrapXaiProviderStream({
      streamFn: baseStreamFn,
      extraParams: { fastMode: true },
    } as never);

    void wrapped?.(
      {
        api: "openai-responses",
        provider: "xai",
        id: "grok-4",
      } as Model<"openai-responses">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedModelId).toBe("grok-4-fast");
    expect(capturedPayload).toMatchObject({ tool_stream: true });
    expect(capturedPayload).not.toHaveProperty("reasoning");
    const payloadTools = capturedPayload?.tools as ToolPayload[] | undefined;
    expect(payloadTools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("strips unsupported strict and reasoning controls from tool payloads", () => {
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
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload, {} as Model<"openai-completions">);
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = createXaiToolPayloadCompatibilityWrapper(baseStreamFn);

    void wrapped(
      {
        api: "openai-completions",
        provider: "xai",
        id: "grok-4-1-fast-reasoning",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoningEffort");
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload.tools[0]?.function).not.toHaveProperty("strict");
  });

  it("strips unsupported reasoning controls from xai payloads", () => {
    const payload: Record<string, unknown> = {
      reasoning: { effort: "high" },
      reasoningEffort: "high",
      reasoning_effort: "high",
    };
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload, {} as Model<"openai-responses">);
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = createXaiToolPayloadCompatibilityWrapper(baseStreamFn);

    void wrapped(
      {
        api: "openai-responses",
        provider: "xai",
        id: "grok-4-fast",
      } as Model<"openai-responses">,
      { messages: [] } as Context,
      {},
    );

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoningEffort");
    expect(payload).not.toHaveProperty("reasoning_effort");
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
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload, {} as Model<"openai-responses">);
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = createXaiToolPayloadCompatibilityWrapper(baseStreamFn);

    void wrapped(
      {
        api: "openai-responses",
        provider: "xai",
        id: "grok-4-fast",
        input: ["text", "image"],
      } as Model<"openai-responses">,
      { messages: [] } as Context,
      {},
    );

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
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload, {} as Model<"openai-responses">);
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = createXaiToolPayloadCompatibilityWrapper(baseStreamFn);

    void wrapped(
      {
        api: "openai-responses",
        provider: "xai",
        id: "grok-4-fast",
        input: ["text", "image"],
      } as Model<"openai-responses">,
      { messages: [] } as Context,
      {},
    );

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
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload, {} as Model<"openai-responses">);
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = createXaiToolPayloadCompatibilityWrapper(baseStreamFn);

    void wrapped(
      {
        api: "openai-responses",
        provider: "xai",
        id: "grok-4-fast",
        input: ["text", "image"],
      } as Model<"openai-responses">,
      { messages: [] } as Context,
      {},
    );

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
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload, {} as Model<"openai-responses">);
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = createXaiToolPayloadCompatibilityWrapper(baseStreamFn);

    void wrapped(
      {
        api: "openai-responses",
        provider: "xai",
        id: "grok-4-fast",
        input: ["text"],
      } as Model<"openai-responses">,
      { messages: [] } as Context,
      {},
    );

    expect(payload.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "(see attached image)",
      },
    ]);
  });
});
