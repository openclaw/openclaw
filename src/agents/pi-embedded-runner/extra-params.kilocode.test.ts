import type { Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { captureEnv } from "../../test-utils/env.js";
import { runExtraParamsCase } from "./extra-params.test-support.js";

const TEST_CFG = {
  plugins: {
    entries: {
      kilocode: {
        enabled: true,
      },
    },
  },
} satisfies OpenClawConfig;

function applyAndCapture(params: {
  provider: string;
  modelId: string;
  callerHeaders?: Record<string, string>;
  cfg?: OpenClawConfig;
}) {
  return runExtraParamsCase({
    applyModelId: params.modelId,
    applyProvider: params.provider,
    callerHeaders: params.callerHeaders,
    cfg: params.cfg ?? TEST_CFG,
    model: {
      api: "openai-completions",
      provider: params.provider,
      id: params.modelId,
    } as Model<"openai-completions">,
    payload: {},
  });
}

function applyAndCaptureReasoning(params: {
  cfg?: OpenClawConfig;
  modelId: string;
  initialPayload?: Record<string, unknown>;
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
}) {
  return runExtraParamsCase({
    applyModelId: params.modelId,
    applyProvider: "kilocode",
    cfg: params.cfg ?? TEST_CFG,
    model: {
      api: "openai-completions",
      provider: "kilocode",
      id: params.modelId,
    } as Model<"openai-completions">,
    payload: { ...params.initialPayload },
    thinkingLevel: params.thinkingLevel ?? "high",
  }).payload;
}

describe("extra-params: Kilocode wrapper", () => {
  const envSnapshot = captureEnv(["KILOCODE_FEATURE"]);

  afterEach(() => {
    envSnapshot.restore();
  });

  it("injects X-KILOCODE-FEATURE header with default value", () => {
    delete process.env.KILOCODE_FEATURE;

    const { headers } = applyAndCapture({
      provider: "kilocode",
      modelId: "anthropic/claude-sonnet-4",
    });

    expect(headers?.["X-KILOCODE-FEATURE"]).toBe("openclaw");
  });

  it("reads X-KILOCODE-FEATURE from KILOCODE_FEATURE env var", () => {
    process.env.KILOCODE_FEATURE = "custom-feature";

    const { headers } = applyAndCapture({
      provider: "kilocode",
      modelId: "anthropic/claude-sonnet-4",
    });

    expect(headers?.["X-KILOCODE-FEATURE"]).toBe("custom-feature");
  });

  it("cannot be overridden by caller headers", () => {
    delete process.env.KILOCODE_FEATURE;

    const { headers } = applyAndCapture({
      provider: "kilocode",
      modelId: "anthropic/claude-sonnet-4",
      callerHeaders: { "X-KILOCODE-FEATURE": "should-be-overwritten" },
    });

    expect(headers?.["X-KILOCODE-FEATURE"]).toBe("openclaw");
  });

  it("keeps Kilocode runtime wrapping under restrictive plugins.allow", () => {
    delete process.env.KILOCODE_FEATURE;

    const { headers } = applyAndCapture({
      provider: "kilocode",
      modelId: "anthropic/claude-sonnet-4",
      cfg: {
        plugins: {
          allow: ["openrouter"],
        },
      },
    });

    expect(headers?.["X-KILOCODE-FEATURE"]).toBe("openclaw");
  });

  it("does not inject header for non-kilocode providers", () => {
    const { headers } = applyAndCapture({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4",
    });

    expect(headers?.["X-KILOCODE-FEATURE"]).toBeUndefined();
  });
});

describe("extra-params: Kilocode kilo/auto reasoning", () => {
  it("does not inject reasoning.effort for kilo/auto", () => {
    const capturedPayload = applyAndCaptureReasoning({
      modelId: "kilo/auto",
      initialPayload: { reasoning_effort: "high" },
    });

    // kilo/auto should not have reasoning injected
    expect(capturedPayload?.reasoning).toBeUndefined();
    expect(capturedPayload).not.toHaveProperty("reasoning_effort");
  });

  it("injects reasoning.effort for non-auto kilocode models", () => {
    const capturedPayload = applyAndCaptureReasoning({
      modelId: "anthropic/claude-sonnet-4",
    });

    // Non-auto models should have reasoning injected
    expect(capturedPayload?.reasoning).toEqual({ effort: "high" });
  });

  it("still normalizes reasoning for Kilocode under restrictive plugins.allow", () => {
    const capturedPayload = applyAndCaptureReasoning({
      cfg: {
        plugins: {
          allow: ["openrouter"],
        },
      },
      modelId: "anthropic/claude-sonnet-4",
    });

    expect(capturedPayload?.reasoning).toEqual({ effort: "high" });
  });

  it("does not inject reasoning.effort for x-ai models", () => {
    const capturedPayload = runExtraParamsCase({
      applyModelId: "x-ai/grok-3",
      applyProvider: "kilocode",
      cfg: TEST_CFG,
      model: {
        api: "openai-completions",
        provider: "kilocode",
        id: "x-ai/grok-3",
      } as Model<"openai-completions">,
      payload: { reasoning_effort: "high" },
      thinkingLevel: "high",
    }).payload;

    // x-ai models reject reasoning.effort — should be skipped
    expect(capturedPayload?.reasoning).toBeUndefined();
    expect(capturedPayload).not.toHaveProperty("reasoning_effort");
  });
});
