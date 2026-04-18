import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

describe("extra-params: llama.cpp thinking bridge", () => {
  it("mirrors enable_thinking into chat_template_kwargs.enable_thinking", () => {
    let capturedPayload: Record<string, unknown> | undefined;

    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload: Record<string, unknown> = { enable_thinking: true };
      options?.onPayload?.(payload, model);
      capturedPayload = payload;
      return createAssistantMessageEventStream();
    };

    const agent = { streamFn: baseStreamFn };
    const cfg = {
      agents: {
        defaults: {
          models: {
            "brain/gemma-4-26B-A4B-4B-embeddings": {
              params: {
                mirror_enable_thinking_to_chat_template_kwargs: true,
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "brain", "gemma-4-26B-A4B-4B-embeddings");

    const model = {
      api: "openai-completions",
      provider: "brain",
      id: "gemma-4-26B-A4B-4B-embeddings",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    expect(capturedPayload?.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it("preserves existing chat_template_kwargs values", () => {
    let capturedPayload: Record<string, unknown> | undefined;

    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload: Record<string, unknown> = {
        enable_thinking: false,
        chat_template_kwargs: { keep_past_thinking: true },
      };
      options?.onPayload?.(payload, model);
      capturedPayload = payload;
      return createAssistantMessageEventStream();
    };

    const agent = { streamFn: baseStreamFn };
    const cfg = {
      agents: {
        defaults: {
          models: {
            "brain/gemma-4-26B-A4B-4B-embeddings": {
              params: {
                mirror_enable_thinking_to_chat_template_kwargs: true,
                chat_template_kwargs: {
                  custom_flag: "on",
                },
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "brain", "gemma-4-26B-A4B-4B-embeddings");

    const model = {
      api: "openai-completions",
      provider: "brain",
      id: "gemma-4-26B-A4B-4B-embeddings",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    expect(capturedPayload?.chat_template_kwargs).toEqual({
      keep_past_thinking: true,
      custom_flag: "on",
      enable_thinking: false,
    });
  });
});
