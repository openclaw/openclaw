import { describe, expect, it, vi } from "vitest";
import {
  createGoogleThinkingPayloadWrapper,
  sanitizeGoogleThinkingPayload,
} from "./google-stream-wrappers.js";

describe("sanitizeGoogleThinkingPayload — gemini-2.5-pro zero budget", () => {
  it("removes thinkingBudget=0 for gemini-2.5-pro", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    sanitizeGoogleThinkingPayload({ payload, modelId: "gemini-2.5-pro" });
    expect(payload.config).not.toHaveProperty("thinkingConfig");
  });

  it("removes thinkingBudget=0 for gemini-2.5-pro with provider prefix", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    sanitizeGoogleThinkingPayload({ payload, modelId: "google/gemini-2.5-pro-preview" });
    expect(payload.config).not.toHaveProperty("thinkingConfig");
  });

  it("removes only thinkingBudget and preserves other thinkingConfig keys", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 0, includeThoughts: true },
      },
    };
    sanitizeGoogleThinkingPayload({ payload, modelId: "gemini-2.5-pro" });
    expect(payload.config.thinkingConfig).not.toHaveProperty("thinkingBudget");
    expect(payload.config.thinkingConfig).toHaveProperty("includeThoughts", true);
  });

  it("removes thinkingBudget=0 from native Google generationConfig payloads", () => {
    const payload = {
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0, includeThoughts: true },
      },
    };
    sanitizeGoogleThinkingPayload({ payload, modelId: "gemini-2.5-pro" });
    expect(payload.generationConfig.thinkingConfig).not.toHaveProperty("thinkingBudget");
    expect(payload.generationConfig.thinkingConfig).toHaveProperty("includeThoughts", true);
  });

  it("keeps thinkingBudget=0 for gemini-2.5-flash (not thinking-required)", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    sanitizeGoogleThinkingPayload({ payload, modelId: "gemini-2.5-flash" });
    expect(payload.config.thinkingConfig).toHaveProperty("thinkingBudget", 0);
  });

  it("keeps positive thinkingBudget for gemini-2.5-pro", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 1000 },
      },
    };
    sanitizeGoogleThinkingPayload({ payload, modelId: "gemini-2.5-pro" });
    expect(payload.config.thinkingConfig).toHaveProperty("thinkingBudget", 1000);
  });

  it("rewrites Gemini 3 Pro budgets to thinkingLevel", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
      },
    };
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-3.1-pro-preview",
      thinkingLevel: "high",
    });
    expect(payload.config.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH",
    });
  });

  it("rewrites Gemini 3 Flash latest disabled budgets to minimal thinkingLevel", () => {
    const payload = {
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-flash-latest",
      thinkingLevel: "off",
    });
    expect(payload.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "MINIMAL",
    });
  });

  it("rewrites Gemini 3 Flash negative budgets when a fixed thinking level is explicit", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: -1, includeThoughts: true },
      },
    };
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-3-flash-preview",
      thinkingLevel: "medium",
    });
    expect(payload.config.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "MEDIUM",
    });
  });

  it("keeps Gemini 3 adaptive thinking on provider dynamic defaults", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 8192, includeThoughts: true },
      },
    };
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-3-flash-preview",
      thinkingLevel: "adaptive",
    });
    expect(payload.config.thinkingConfig).toEqual({
      includeThoughts: true,
    });
  });

  it("maps Gemini 2.5 adaptive thinking to thinkingBudget=-1", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 8192, includeThoughts: true },
      },
    };
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-2.5-flash",
      thinkingLevel: "adaptive",
    });
    expect(payload.config.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: -1,
    });
  });
});

describe("createGoogleThinkingPayloadWrapper — Google API shape coverage (#38327)", () => {
  // The wrapper's payload-sanitize step previously gated on a single
  // `model.api === "google-generative-ai"` string. That guard left
  // `google-vertex` and `google-gemini-cli` routes uncovered, so
  // embedded-runner streams hit the unhandled negative `thinkingBudget`
  // and crashed with "Cannot convert undefined or null to object"
  // (issue #38327, still reproducing on v2026.4.21+ per fxstein's
  // forensic notes on the issue). OpenAI-completions-shaped Vertex
  // routes (`Vertex Model Garden / OpenAI-compatible API`) remain out
  // of scope of this guard widening.
  async function runWrapper(model: { api: string; id: string; provider?: string }) {
    let captured: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn(async function* (_model: unknown, _ctx: unknown, options: unknown) {
      const onPayload = (options as { onPayload?: (payload: unknown) => void } | undefined)
        ?.onPayload;
      onPayload?.({
        config: { thinkingConfig: { thinkingBudget: -1 } },
      });
      // Empty generator: payload capture happens via the onPayload callback above,
      // so the iterable yields no chunks (mirrors the production guard's no-op path).
      yield* [];
    });
    const wrapped = createGoogleThinkingPayloadWrapper(baseStreamFn as never, undefined);
    const generator = wrapped(model as never, { messages: [] } as never, {
      onPayload: (payload: unknown) => {
        captured = payload as Record<string, unknown>;
      },
    } as never) as AsyncIterable<unknown>;
    for await (const _chunk of generator) {
      // drain
    }
    return captured;
  }

  it("strips negative thinkingBudget for api=google-generative-ai (existing behavior preserved)", async () => {
    const payload = await runWrapper({
      api: "google-generative-ai",
      id: "gemini-3.1-pro-preview",
      provider: "google",
    });
    expect((payload?.config as { thinkingConfig?: unknown })?.thinkingConfig).toBeUndefined();
  });

  it("strips negative thinkingBudget for api=google-vertex (regression #38327)", async () => {
    const payload = await runWrapper({
      api: "google-vertex",
      id: "gemini-3.1-pro-preview",
      provider: "google-vertex",
    });
    expect((payload?.config as { thinkingConfig?: unknown })?.thinkingConfig).toBeUndefined();
  });

  it("strips negative thinkingBudget for api=google-gemini-cli (regression #38327)", async () => {
    const payload = await runWrapper({
      api: "google-gemini-cli",
      id: "gemini-3.1-pro-preview",
      provider: "google",
    });
    expect((payload?.config as { thinkingConfig?: unknown })?.thinkingConfig).toBeUndefined();
  });

  it("does not sanitize for unrelated APIs (api=anthropic stays untouched)", async () => {
    const payload = await runWrapper({ api: "anthropic", id: "claude-sonnet-4.6" });
    expect((payload?.config as { thinkingConfig?: unknown })?.thinkingConfig).toEqual({
      thinkingBudget: -1,
    });
  });
});
