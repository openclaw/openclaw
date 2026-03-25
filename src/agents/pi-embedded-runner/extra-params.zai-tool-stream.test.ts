import type { Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createPiAiStreamSimpleMock } from "./extra-params.pi-ai-mock.js";
import { runExtraParamsCase } from "./extra-params.test-support.js";

vi.mock("@mariozechner/pi-ai", async (importOriginal) =>
  createPiAiStreamSimpleMock(() => importOriginal<typeof import("@mariozechner/pi-ai")>()),
);

type ToolStreamCase = {
  applyProvider: string;
  applyModelId: string;
  model: Model<"openai-completions">;
  cfg?: OpenClawConfig;
  options?: SimpleStreamOptions;
};

function runToolStreamCase(params: ToolStreamCase) {
  return runExtraParamsCase({
    applyModelId: params.applyModelId,
    applyProvider: params.applyProvider,
    cfg: params.cfg,
    model: params.model,
    options: params.options,
    payload: { model: params.model.id, messages: [] },
  }).payload as Record<string, unknown>;
}

describe("extra-params: provider tool_stream support", () => {
  it("injects tool_stream=true for zai provider by default", () => {
    const payload = runToolStreamCase({
      applyProvider: "zai",
      applyModelId: "glm-5",
      model: {
        api: "openai-completions",
        provider: "zai",
        id: "glm-5",
      } as Model<"openai-completions">,
    });

    expect(payload.tool_stream).toBe(true);
  });

  it("injects tool_stream=true for xai provider by default", () => {
    const payload = runToolStreamCase({
      applyProvider: "xai",
      applyModelId: "grok-4-1-fast-reasoning",
      model: {
        api: "openai-completions",
        provider: "xai",
        id: "grok-4-1-fast-reasoning",
      } as Model<"openai-completions">,
    });

    expect(payload.tool_stream).toBe(true);
  });

  it("does not inject tool_stream for providers that do not need it", () => {
    const payload = runToolStreamCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-5",
      } as Model<"openai-completions">,
    });

    expect(payload).not.toHaveProperty("tool_stream");
  });

  it("allows disabling zai tool_stream via params", () => {
    const payload = runToolStreamCase({
      applyProvider: "zai",
      applyModelId: "glm-5",
      model: {
        api: "openai-completions",
        provider: "zai",
        id: "glm-5",
      } as Model<"openai-completions">,
      cfg: {
        agents: {
          defaults: {
            models: {
              "zai/glm-5": {
                params: {
                  tool_stream: false,
                },
              },
            },
          },
        },
      },
    });

    expect(payload).not.toHaveProperty("tool_stream");
  });

  it("allows disabling xai tool_stream via params", () => {
    const payload = runToolStreamCase({
      applyProvider: "xai",
      applyModelId: "grok-4-1-fast-reasoning",
      model: {
        api: "openai-completions",
        provider: "xai",
        id: "grok-4-1-fast-reasoning",
      } as Model<"openai-completions">,
      cfg: {
        agents: {
          defaults: {
            models: {
              "xai/grok-4-1-fast-reasoning": {
                params: {
                  tool_stream: false,
                },
              },
            },
          },
        },
      },
    });

    expect(payload).not.toHaveProperty("tool_stream");
  });
});
