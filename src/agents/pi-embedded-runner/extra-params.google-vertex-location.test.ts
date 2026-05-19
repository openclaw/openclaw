import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { applyExtraParamsToAgent, resolveModelLocation } from "./extra-params.js";
import { createGoogleVertexLocationWrapper } from "./google-stream-wrappers.js";

vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: vi.fn(() => ({
    push: vi.fn(),
    result: vi.fn(),
  })),
}));

function buildCfg(models: Record<string, { location?: string; alias?: string }>): OpenClawConfig {
  return { agents: { defaults: { models } } } as unknown as OpenClawConfig;
}

function captureOptions(modelId: string, provider: string, cfg: OpenClawConfig | undefined) {
  let captured: Record<string, unknown> | undefined;
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    captured = options as Record<string, unknown>;
    return {} as ReturnType<StreamFn>;
  };
  const agent = { streamFn: baseStreamFn };
  applyExtraParamsToAgent(agent, cfg, provider, modelId);
  const model = {
    api: "google-vertex",
    provider,
    id: modelId,
  } as unknown as Model<"openai-completions">;
  const context: Context = { messages: [] };
  void agent.streamFn?.(model, context, {});
  return captured;
}

describe("google-vertex per-model location override", () => {
  it("resolveModelLocation returns the configured location for a vertex model", () => {
    const cfg = buildCfg({
      "google-vertex/gemini-2.5-pro": { location: "us-central1" },
    });
    expect(
      resolveModelLocation({ cfg, provider: "google-vertex", modelId: "gemini-2.5-pro" }),
    ).toBe("us-central1");
  });

  it("resolveModelLocation returns undefined when location is missing or blank", () => {
    expect(
      resolveModelLocation({
        cfg: buildCfg({ "google-vertex/gemini-2.5-pro": {} }),
        provider: "google-vertex",
        modelId: "gemini-2.5-pro",
      }),
    ).toBeUndefined();
    expect(
      resolveModelLocation({
        cfg: buildCfg({ "google-vertex/gemini-2.5-pro": { location: "  " } }),
        provider: "google-vertex",
        modelId: "gemini-2.5-pro",
      }),
    ).toBeUndefined();
  });

  it("injects location into stream options for google-vertex models", () => {
    const cfg = buildCfg({
      "google-vertex/gemini-2.5-pro": { location: "us-central1" },
    });
    const options = captureOptions("gemini-2.5-pro", "google-vertex", cfg);
    expect(options?.location).toBe("us-central1");
  });

  it("does not inject location when no override is configured", () => {
    const cfg = buildCfg({
      "google-vertex/gemini-3.1-pro-preview": { alias: "gemini" },
    });
    const options = captureOptions("gemini-3.1-pro-preview", "google-vertex", cfg);
    expect(options?.location).toBeUndefined();
  });

  it("wrapper passes through non-vertex models without touching options", () => {
    let captured: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      captured = options as Record<string, unknown>;
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = createGoogleVertexLocationWrapper(baseStreamFn, "us-central1");
    const model = {
      api: "google-generative-ai",
      provider: "google",
      id: "gemini-2.5-pro",
    } as unknown as Model<"openai-completions">;
    void wrapped(model, { messages: [] } as Context, {});
    expect(captured?.location).toBeUndefined();
  });
});
