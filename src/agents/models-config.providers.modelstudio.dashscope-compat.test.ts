import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { upsertAuthProfile } from "./auth-profiles.js";
import { normalizeModelCompat } from "./model-compat.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

/**
 * DashScope/Bailian endpoint compatibility tests for the Model Studio provider.
 *
 * Verifies that models resolved through the modelstudio implicit provider
 * receive correct compat flags when processed by normalizeModelCompat:
 * - supportsDeveloperRole must be false (DashScope rejects the `developer` role)
 * - supportsUsageInStreaming defaults to false for non-native OpenAI endpoints
 *
 * Related issues:
 * - #28731: `developer` role not supported by Alibaba Cloud Bailian API
 * - #45038: Token usage always 0 for non-native OpenAI endpoints
 * - #21114: DashScope non-streaming fails without `enable_thinking`
 */

const modelStudioApiKeyEnv = ["MODELSTUDIO_API", "KEY"].join("_");

const dashScopeModel = (overrides?: Partial<Model<Api>>): Model<Api> =>
  ({
    id: "qwen3.5-plus",
    name: "qwen3.5-plus",
    api: "openai-completions",
    provider: "modelstudio",
    baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    ...overrides,
  }) as Model<Api>;

function supportsDeveloperRole(model: Model<Api>): boolean | undefined {
  return (model.compat as { supportsDeveloperRole?: boolean } | undefined)?.supportsDeveloperRole;
}

function supportsUsageInStreaming(model: Model<Api>): boolean | undefined {
  return (model.compat as { supportsUsageInStreaming?: boolean } | undefined)
    ?.supportsUsageInStreaming;
}

describe("Model Studio DashScope compatibility", () => {
  it("includes modelstudio when auth profile uses env keyRef (no env var set)", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv([modelStudioApiKeyEnv]);
    delete process.env[modelStudioApiKeyEnv];

    upsertAuthProfile({
      profileId: "modelstudio:default",
      credential: {
        type: "api_key",
        provider: "modelstudio",
        keyRef: { source: "env", provider: "default", id: modelStudioApiKeyEnv },
      },
      agentDir,
    });

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.modelstudio?.apiKey).toBe(modelStudioApiKeyEnv);
    } finally {
      envSnapshot.restore();
    }
  });

  it("resolves modelstudio base URL to DashScope international endpoint", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv([modelStudioApiKeyEnv]);
    process.env[modelStudioApiKeyEnv] = "test-key"; // pragma: allowlist secret

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.modelstudio?.baseUrl).toMatch(/dashscope\.aliyuncs\.com/);
    } finally {
      envSnapshot.restore();
    }
  });

  it("forces supportsDeveloperRole off for modelstudio DashScope endpoint", () => {
    const normalized = normalizeModelCompat(dashScopeModel());
    expect(supportsDeveloperRole(normalized)).toBe(false);
  });

  it("forces supportsDeveloperRole off for China DashScope endpoint", () => {
    const normalized = normalizeModelCompat(
      dashScopeModel({ baseUrl: "https://coding.dashscope.aliyuncs.com/v1" }),
    );
    expect(supportsDeveloperRole(normalized)).toBe(false);
  });

  it("forces supportsUsageInStreaming off for modelstudio DashScope endpoint by default", () => {
    const normalized = normalizeModelCompat(dashScopeModel());
    expect(supportsUsageInStreaming(normalized)).toBe(false);
  });

  it("respects explicit supportsUsageInStreaming override on DashScope endpoint", () => {
    const model = dashScopeModel();
    (model as { compat?: Record<string, boolean> }).compat = {
      supportsUsageInStreaming: true,
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsUsageInStreaming(normalized)).toBe(true);
  });

  it("respects explicit supportsDeveloperRole override on DashScope endpoint", () => {
    const model = dashScopeModel();
    (model as { compat?: Record<string, boolean> }).compat = {
      supportsDeveloperRole: true,
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(true);
  });

  it("forces compat flags off for user-configured DashScope compatible-mode endpoints", () => {
    const normalized = normalizeModelCompat(
      dashScopeModel({
        id: "qwen-turbo",
        name: "qwen-turbo",
        provider: "custom-dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      }),
    );
    expect(supportsDeveloperRole(normalized)).toBe(false);
    expect(supportsUsageInStreaming(normalized)).toBe(false);
  });

  it("forces compat flags off for international DashScope compatible-mode endpoints", () => {
    const normalized = normalizeModelCompat(
      dashScopeModel({
        id: "qwen-max",
        name: "qwen-max",
        provider: "custom-dashscope-intl",
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      }),
    );
    expect(supportsDeveloperRole(normalized)).toBe(false);
    expect(supportsUsageInStreaming(normalized)).toBe(false);
  });

  it("does not mutate the original model object", () => {
    const model = dashScopeModel();
    const normalized = normalizeModelCompat(model);
    expect(normalized).not.toBe(model);
    expect(supportsDeveloperRole(model)).toBeUndefined();
    expect(supportsUsageInStreaming(model)).toBeUndefined();
  });

  it("uses openai-completions API type for all modelstudio catalog models", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv([modelStudioApiKeyEnv]);
    process.env[modelStudioApiKeyEnv] = "test-key"; // pragma: allowlist secret

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.modelstudio?.api).toBe("openai-completions");
    } finally {
      envSnapshot.restore();
    }
  });
});
