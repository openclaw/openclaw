// Zai tests cover Coding Plan system-prompt compatibility behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { isZaiCodingBaseUrl, transformZaiCodingSystemPrompt } from "./coding-prompt-compat.js";
import {
  ZAI_CN_BASE_URL,
  ZAI_CODING_CN_BASE_URL,
  ZAI_CODING_GLOBAL_BASE_URL,
  ZAI_GLOBAL_BASE_URL,
} from "./model-definitions.js";

const BLOCKED_LINE = "You are a personal assistant running inside OpenClaw.";
const REWRITTEN_LINE = "You are a personal assistant running within OpenClaw.";

type ProviderEntry = {
  baseUrl?: string;
  models?: Array<{ id: string; baseUrl?: string }>;
};

function buildConfig(providers: Record<string, ProviderEntry>): OpenClawConfig {
  return { models: { providers } } as unknown as OpenClawConfig;
}

function transform(params: {
  providers: Record<string, ProviderEntry>;
  systemPrompt?: string;
  provider?: string;
  modelId?: string;
}): string | undefined {
  return transformZaiCodingSystemPrompt({
    config: buildConfig(params.providers),
    provider: params.provider ?? "zai",
    modelId: params.modelId ?? "glm-5.2",
    systemPrompt: params.systemPrompt ?? BLOCKED_LINE,
  });
}

describe("isZaiCodingBaseUrl", () => {
  it("matches both official Coding Plan endpoints", () => {
    expect(isZaiCodingBaseUrl(ZAI_CODING_GLOBAL_BASE_URL)).toBe(true);
    expect(isZaiCodingBaseUrl(ZAI_CODING_CN_BASE_URL)).toBe(true);
  });

  it("matches reverse proxies that preserve the coding path", () => {
    expect(isZaiCodingBaseUrl("http://127.0.0.1:9998/api/coding/paas/v4")).toBe(true);
  });

  it("rejects ordinary Z.AI endpoints and empty values", () => {
    expect(isZaiCodingBaseUrl(ZAI_GLOBAL_BASE_URL)).toBe(false);
    expect(isZaiCodingBaseUrl(ZAI_CN_BASE_URL)).toBe(false);
    expect(isZaiCodingBaseUrl(undefined)).toBe(false);
    expect(isZaiCodingBaseUrl("")).toBe(false);
    expect(isZaiCodingBaseUrl("   ")).toBe(false);
  });
});

describe("transformZaiCodingSystemPrompt", () => {
  it("rewrites only the blocked identity line on Coding Plan routes", () => {
    const prompt = `${BLOCKED_LINE}\nOpenClaw routes messages across channels.\nUse OpenClaw tools.`;
    const transformed = transform({
      providers: { zai: { baseUrl: ZAI_CODING_GLOBAL_BASE_URL } },
      systemPrompt: prompt,
    });
    expect(transformed).toBe(
      `${REWRITTEN_LINE}\nOpenClaw routes messages across channels.\nUse OpenClaw tools.`,
    );
    expect(transformed).not.toContain("running inside OpenClaw");
  });

  it("rewrites every occurrence of the blocked line", () => {
    const prompt = `${BLOCKED_LINE}\nintermediate text\n${BLOCKED_LINE}`;
    const transformed = transform({
      providers: { zai: { baseUrl: ZAI_CODING_CN_BASE_URL } },
      systemPrompt: prompt,
    });
    expect(transformed).toBe(`${REWRITTEN_LINE}\nintermediate text\n${REWRITTEN_LINE}`);
  });

  it("uses a per-model baseUrl override that routes to a Coding Plan endpoint", () => {
    expect(
      transform({
        providers: {
          zai: {
            baseUrl: ZAI_GLOBAL_BASE_URL,
            models: [{ id: "glm-5.2", baseUrl: ZAI_CODING_GLOBAL_BASE_URL }],
          },
        },
      }),
    ).toBe(REWRITTEN_LINE);
  });

  it("matches provider-scoped per-model config ids", () => {
    expect(
      transform({
        providers: {
          zai: {
            models: [{ id: "zai/glm-5.2", baseUrl: ZAI_CODING_GLOBAL_BASE_URL }],
          },
        },
      }),
    ).toBe(REWRITTEN_LINE);
  });

  it("lets an ordinary per-model baseUrl override a coding provider baseUrl", () => {
    expect(
      transform({
        providers: {
          zai: {
            baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
            models: [{ id: "glm-5.2", baseUrl: ZAI_GLOBAL_BASE_URL }],
          },
        },
      }),
    ).toBeUndefined();
  });

  it("ignores per-model overrides for other model ids", () => {
    expect(
      transform({
        providers: {
          zai: {
            baseUrl: ZAI_GLOBAL_BASE_URL,
            models: [{ id: "glm-5.1", baseUrl: ZAI_CODING_GLOBAL_BASE_URL }],
          },
        },
        modelId: "glm-5.2",
      }),
    ).toBeUndefined();
  });

  it("resolves provider config keys case-insensitively like core resolution", () => {
    expect(
      transform({
        providers: { ZAI: { baseUrl: ZAI_CODING_GLOBAL_BASE_URL } },
      }),
    ).toBe(REWRITTEN_LINE);
  });

  it("resolves alias provider ids against their exact config keys", () => {
    expect(
      transform({
        providers: { "z-ai": { baseUrl: ZAI_CODING_GLOBAL_BASE_URL } },
        provider: "z-ai",
      }),
    ).toBe(REWRITTEN_LINE);
  });

  it("leaves ordinary Z.AI routes byte-identical", () => {
    expect(transform({ providers: { zai: { baseUrl: ZAI_GLOBAL_BASE_URL } } })).toBeUndefined();
    expect(transform({ providers: { zai: {} } })).toBeUndefined();
    expect(
      transformZaiCodingSystemPrompt({
        provider: "zai",
        modelId: "glm-5.2",
        systemPrompt: BLOCKED_LINE,
      }),
    ).toBeUndefined();
  });

  it("leaves Coding Plan prompts without the blocked line unchanged", () => {
    expect(
      transform({
        providers: { zai: { baseUrl: ZAI_CODING_GLOBAL_BASE_URL } },
        systemPrompt: "You are a helpful assistant.",
      }),
    ).toBeUndefined();
  });

  it("does not touch case variants the provider filter ignores", () => {
    expect(
      transform({
        providers: { zai: { baseUrl: ZAI_CODING_GLOBAL_BASE_URL } },
        systemPrompt: "you are a personal assistant running inside openclaw.",
      }),
    ).toBeUndefined();
  });
});
