import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

type Case = {
  applyProvider: string;
  applyModelId: string;
  model: Model<"openai-completions">;
  cfg?: Parameters<typeof applyExtraParamsToAgent>[1];
};

function runCase(params: Case) {
  const payload: Record<string, unknown> = { model: params.model.id, messages: [] };
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    // Mirror pi-ai's behavior: include stream_options unless compat says not to.
    const compat = (params.model as unknown as { compat?: Record<string, unknown> }).compat ?? {};
    const supportsStreamOptions = compat.supportsStreamOptions;
    const supportsUsageInStreaming = compat.supportsUsageInStreaming;
    if (supportsStreamOptions !== false && supportsUsageInStreaming !== false) {
      payload.stream_options = { include_usage: true };
    }

    options?.onPayload?.(payload);
    return {} as ReturnType<StreamFn>;
  };

  const agent = { streamFn: baseStreamFn };
  applyExtraParamsToAgent(agent, params.cfg, params.applyProvider, params.applyModelId);

  const context: Context = { messages: [] };
  const options: SimpleStreamOptions = {
    onPayload: (p) => Object.assign(payload, p as Record<string, unknown>),
  };

  void agent.streamFn?.(params.model, context, options);
  return payload;
}

describe("extra-params: stream_options compatibility", () => {
  it("does not send stream_options when compat.supportsStreamOptions=false", () => {
    const payload = runCase({
      applyProvider: "zai",
      applyModelId: "glm-4.7",
      model: {
        api: "openai-completions",
        provider: "zai",
        id: "glm-4.7",
        compat: {
          supportsStreamOptions: false,
        },
      } as unknown as Model<"openai-completions">,
    });

    expect(payload).not.toHaveProperty("stream_options");
  });
});
