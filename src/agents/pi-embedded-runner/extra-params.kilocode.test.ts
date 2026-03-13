import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { captureEnv } from "../../test-utils/env.js";
import { applyExtraParamsToAgent } from "./extra-params.js";

type CapturedCall = {
  headers?: Record<string, string>;
  payload?: Record<string, unknown>;
};

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
}): CapturedCall {
  const captured: CapturedCall = {};

  const baseStreamFn: StreamFn = (model, _context, options) => {
    captured.headers = options?.headers;
    options?.onPayload?.({}, model);
    return createAssistantMessageEventStream();
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(agent, params.cfg ?? TEST_CFG, params.provider, params.modelId);

  const model = {
    api: "openai-completions",
    provider: params.provider,
    id: params.modelId,
  } as Model<"openai-completions">;
  const context: Context = { messages: [] };

  void agent.streamFn?.(model, context, {
    headers: params.callerHeaders,
  });

  return captured;
}

describe("extra-params: Kilocode wrapper", () => {
  const envSnapshot = captureEnv(["KILOCODE_FEATURE", "KILOCODE_ORG_ID"]);

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

  it("injects X-KILOCODE-ORGANIZATIONID when KILOCODE_ORG_ID env var is set", () => {
    process.env.KILOCODE_ORG_ID = "test-org-123";

    const { headers } = applyAndCapture({
      provider: "kilocode",
      modelId: "anthropic/claude-sonnet-4",
    });

    expect(headers?.["X-KILOCODE-ORGANIZATIONID"]).toBe("test-org-123");
  });

  it("does not inject X-KILOCODE-ORGANIZATIONID when KILOCODE_ORG_ID is unset", () => {
    delete process.env.KILOCODE_ORG_ID;

    const { headers } = applyAndCapture({
      provider: "kilocode",
      modelId: "anthropic/claude-sonnet-4",
    });

    expect(headers?.["X-KILOCODE-ORGANIZATIONID"]).toBeUndefined();
  });

  it("does not inject X-KILOCODE-ORGANIZATIONID for non-kilocode providers even if env var is set", () => {
    process.env.KILOCODE_ORG_ID = "test-org-123";

    const { headers } = applyAndCapture({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4",
    });

    expect(headers?.["X-KILOCODE-ORGANIZATIONID"]).toBeUndefined();
  });

  it("injects X-KILOCODE-ORGANIZATIONID from provider config organizationId field", () => {
    delete process.env.KILOCODE_ORG_ID;

    const { headers } = applyAndCapture({
      provider: "kilocode",
      modelId: "anthropic/claude-sonnet-4",
      cfg: {
        models: {
          providers: {
            kilocode: {
              baseUrl: "https://api.kilo.ai/api/gateway/",
              models: [],
              organizationId: "provider-org-555",
            },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(headers?.["X-KILOCODE-ORGANIZATIONID"]).toBe("provider-org-555");
  });

  it("provider config organizationId takes precedence over env var", () => {
    process.env.KILOCODE_ORG_ID = "env-org-999";

    const { headers } = applyAndCapture({
      provider: "kilocode",
      modelId: "anthropic/claude-sonnet-4",
      cfg: {
        models: {
          providers: {
            kilocode: {
              baseUrl: "https://api.kilo.ai/api/gateway/",
              models: [],
              organizationId: "provider-org-555",
            },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(headers?.["X-KILOCODE-ORGANIZATIONID"]).toBe("provider-org-555");
  });
});

describe("extra-params: Kilocode kilo/auto reasoning", () => {
  it("does not inject reasoning.effort for kilo/auto", () => {
    let capturedPayload: Record<string, unknown> | undefined;

    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload: Record<string, unknown> = { reasoning_effort: "high" };
      options?.onPayload?.(payload, model);
      capturedPayload = payload;
      return createAssistantMessageEventStream();
    };
    const agent = { streamFn: baseStreamFn };

    // Pass thinking level explicitly (6th parameter) to trigger reasoning injection
    applyExtraParamsToAgent(agent, TEST_CFG, "kilocode", "kilo/auto", undefined, "high");

    const model = {
      api: "openai-completions",
      provider: "kilocode",
      id: "kilo/auto",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    // kilo/auto should not have reasoning injected
    expect(capturedPayload?.reasoning).toBeUndefined();
    expect(capturedPayload).not.toHaveProperty("reasoning_effort");
  });

  it("injects reasoning.effort for non-auto kilocode models", () => {
    let capturedPayload: Record<string, unknown> | undefined;

    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload, model);
      capturedPayload = payload;
      return createAssistantMessageEventStream();
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      TEST_CFG,
      "kilocode",
      "anthropic/claude-sonnet-4",
      undefined,
      "high",
    );

    const model = {
      api: "openai-completions",
      provider: "kilocode",
      id: "anthropic/claude-sonnet-4",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    // Non-auto models should have reasoning injected
    expect(capturedPayload?.reasoning).toEqual({ effort: "high" });
  });

  it("still normalizes reasoning for Kilocode under restrictive plugins.allow", () => {
    let capturedPayload: Record<string, unknown> | undefined;

    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload, model);
      capturedPayload = payload;
      return createAssistantMessageEventStream();
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      {
        plugins: {
          allow: ["openrouter"],
        },
      },
      "kilocode",
      "anthropic/claude-sonnet-4",
      undefined,
      "high",
    );

    const model = {
      api: "openai-completions",
      provider: "kilocode",
      id: "anthropic/claude-sonnet-4",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    expect(capturedPayload?.reasoning).toEqual({ effort: "high" });
  });

  it("does not inject reasoning.effort for x-ai models", () => {
    let capturedPayload: Record<string, unknown> | undefined;

    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload: Record<string, unknown> = { reasoning_effort: "high" };
      options?.onPayload?.(payload, model);
      capturedPayload = payload;
      return createAssistantMessageEventStream();
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, TEST_CFG, "kilocode", "x-ai/grok-3", undefined, "high");

    const model = {
      api: "openai-completions",
      provider: "kilocode",
      id: "x-ai/grok-3",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    // x-ai models reject reasoning.effort — should be skipped
    expect(capturedPayload?.reasoning).toBeUndefined();
    expect(capturedPayload).not.toHaveProperty("reasoning_effort");
  });
});
