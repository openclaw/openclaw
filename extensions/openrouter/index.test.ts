import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import openrouterPlugin, { injectAutoRouterPlugin } from "./index.js";

describe("openrouter provider hooks", () => {
  it("owns native reasoning output mode", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "openrouter",
        modelApi: "openai-completions",
        modelId: "openai/gpt-5.4",
      } as never),
    ).toBe("native");
  });
});


describe("injectAutoRouterPlugin", () => {
  function makeBaseStreamFn(payloads: Record<string, unknown>[]): StreamFn {
    return (_model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
  }

  it("injects auto-router plugin with allowed_models", () => {
    const payloads: Record<string, unknown>[] = [];
    const wrapped = injectAutoRouterPlugin(makeBaseStreamFn(payloads), [
      "anthropic/claude-haiku-4-5",
      "google/gemini-2.5-flash",
    ]);
    void wrapped({} as never, {} as never, {});
    expect(payloads[0]?.plugins).toEqual([
      {
        id: "auto-router",
        allowed_models: ["anthropic/claude-haiku-4-5", "google/gemini-2.5-flash"],
      },
    ]);
  });

  it("merges with pre-existing plugins rather than overwriting", () => {
    const payloads: Record<string, unknown>[] = [];
    const base: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = { plugins: [{ id: "existing" }] };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = injectAutoRouterPlugin(base, ["anthropic/*"]);
    void wrapped({} as never, {} as never, {});
    expect(payloads[0]?.plugins).toEqual([
      { id: "existing" },
      { id: "auto-router", allowed_models: ["anthropic/*"] },
    ]);
  });
});
