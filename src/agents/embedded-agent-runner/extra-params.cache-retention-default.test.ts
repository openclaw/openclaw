// Coverage for cache-retention defaults and overrides in extra params.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";
import { runExtraParamsCase, testing as extraParamsTesting } from "./extra-params.test-support.js";
import { log } from "./logger.js";
import { resolveCacheRetention } from "./prompt-cache-retention.js";

// Keep cache-retention warning/debug output out of assertion logs.
vi.mock("./logger.js", () => ({
  log: {
    isEnabled: () => false,
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

beforeEach(() => {
  vi.mocked(log.warn).mockClear();
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: () => undefined,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: () => undefined,
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

describe("cacheRetention default behavior", () => {
  it.each(["openai-responses", "openai-chatgpt-responses", "openai-completions"] as const)(
    "forwards configured native OpenAI retention to %s stream options",
    (api) => {
      for (const cacheRetention of ["none", "short", "long"] as const) {
        for (const baseUrl of ["https://api.openai.com/v1", "https://proxy.example/v1"]) {
          const captured = runExtraParamsCase({
            model: {
              id: "gpt-5.4",
              name: "GPT-5.4",
              api,
              provider: "openai",
              baseUrl,
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4096,
            },
            cfg: { agents: { defaults: { params: { cacheRetention } } } },
            payload: {},
          });
          expect(captured.options?.cacheRetention).toBe(
            baseUrl === "https://api.openai.com/v1" ? cacheRetention : undefined,
          );
        }
      }
    },
  );

  it.each([undefined, "none"] as const)(
    "forwards Model Studio explicit retention %s without opting into cache keys",
    (cacheRetention) => {
      const captured = runExtraParamsCase({
        model: {
          id: "qwen-plus",
          name: "Qwen Plus",
          api: "openai-completions",
          provider: "qwen",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 4_096,
        },
        cfg: { agents: { defaults: { params: { temperature: 0.5, cacheRetention } } } },
        payload: {},
      });
      expect(captured.options?.cacheRetention).toBe(cacheRetention);
    },
  );

  it("respects legacy cacheControlTtl config", () => {
    expect(resolveCacheRetention({ cacheControlTtl: "1h" }, "anthropic")).toBe("long");
  });

  it("passes cacheRetention 'long' through for custom anthropic-messages provider", () => {
    expect(resolveCacheRetention({ cacheRetention: "long" }, "litellm", "anthropic-messages")).toBe(
      "long",
    );
  });

  it("does not default to caching for custom provider without explicit config", () => {
    expect(resolveCacheRetention(undefined, "litellm", "anthropic-messages")).toBeUndefined();
  });

  it("keeps explicit cacheRetention for Anthropic Bedrock models", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "amazon-bedrock",
        "openai-completions",
        "us.anthropic.claude-sonnet-4-6",
      ),
    ).toBe("long");
  });

  it.each([undefined, "long"] as const)(
    "preserves %s retention for the Bedrock Converse policy owner",
    (cacheRetention) => {
      expect(
        resolveCacheRetention(
          { cacheRetention },
          "amazon-bedrock",
          "bedrock-converse-stream",
          "amazon.nova-micro-v1:0",
        ),
      ).toBe(cacheRetention);
    },
  );

  it("warns instead of creating an undocumented cacheRetention alias", () => {
    applyExtraParamsToAgent(
      { streamFn: vi.fn<StreamFn>() },
      {
        agents: {
          defaults: {
            models: {
              "amazon-bedrock/us.anthropic.claude-sonnet-4-6": {
                params: { cacheRetention: "standard" },
              },
            },
          },
        },
      },
      "amazon-bedrock",
      "us.anthropic.claude-sonnet-4-6",
    );

    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      'ignoring invalid cacheRetention param; expected "none", "short", or "long"',
    );
  });

  it("defaults to 'short' for anthropic-vertex without explicit config", () => {
    expect(
      resolveCacheRetention(
        undefined,
        "anthropic-vertex",
        "anthropic-messages",
        "claude-sonnet-4-6",
      ),
    ).toBe("short");
  });

  it("passes through explicit cacheRetention for opaque Bedrock app inference profile ARNs", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "amazon-bedrock",
        "openai-completions",
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/z27qyso459da",
      ),
    ).toBe("long");
  });

  it("does not default cacheRetention for opaque Bedrock app inference profile ARNs", () => {
    expect(
      resolveCacheRetention(
        undefined,
        "amazon-bedrock",
        "openai-completions",
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/z27qyso459da",
      ),
    ).toBeUndefined();
  });
});
