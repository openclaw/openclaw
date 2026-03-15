import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const model = {
      id: "qwen3.5-plus",
      api: "openai-completions" as const,
      provider: "modelstudio",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      name: "qwen3.5-plus",
    };

    const normalized = normalizeModelCompat(model);
    const compat = (normalized as { compat?: { supportsDeveloperRole?: boolean } }).compat;
    expect(compat?.supportsDeveloperRole).toBe(false);
  });

  it("forces supportsDeveloperRole off for China DashScope endpoint", () => {
    const model = {
      id: "qwen3.5-plus",
      api: "openai-completions" as const,
      provider: "modelstudio",
      baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
      name: "qwen3.5-plus",
    };

    const normalized = normalizeModelCompat(model);
    const compat = (normalized as { compat?: { supportsDeveloperRole?: boolean } }).compat;
    expect(compat?.supportsDeveloperRole).toBe(false);
  });

  it("forces supportsUsageInStreaming off for modelstudio DashScope endpoint by default", () => {
    const model = {
      id: "qwen3.5-plus",
      api: "openai-completions" as const,
      provider: "modelstudio",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      name: "qwen3.5-plus",
    };

    const normalized = normalizeModelCompat(model);
    const compat = (normalized as { compat?: { supportsUsageInStreaming?: boolean } }).compat;
    expect(compat?.supportsUsageInStreaming).toBe(false);
  });

  it("respects explicit supportsUsageInStreaming override on DashScope endpoint", () => {
    const model = {
      id: "qwen3.5-plus",
      api: "openai-completions" as const,
      provider: "modelstudio",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      name: "qwen3.5-plus",
      compat: { supportsUsageInStreaming: true },
    };

    const normalized = normalizeModelCompat(model);
    const compat = (normalized as { compat?: { supportsUsageInStreaming?: boolean } }).compat;
    expect(compat?.supportsUsageInStreaming).toBe(true);
  });

  it("respects explicit supportsDeveloperRole override on DashScope endpoint", () => {
    const model = {
      id: "qwen3.5-plus",
      api: "openai-completions" as const,
      provider: "modelstudio",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      name: "qwen3.5-plus",
      compat: { supportsDeveloperRole: true },
    };

    const normalized = normalizeModelCompat(model);
    const compat = (normalized as { compat?: { supportsDeveloperRole?: boolean } }).compat;
    expect(compat?.supportsDeveloperRole).toBe(true);
  });

  it("forces compat flags off for user-configured DashScope compatible-mode endpoints", () => {
    const model = {
      id: "qwen-turbo",
      api: "openai-completions" as const,
      provider: "custom-dashscope",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      name: "qwen-turbo",
    };

    const normalized = normalizeModelCompat(model);
    const compat = (
      normalized as {
        compat?: { supportsDeveloperRole?: boolean; supportsUsageInStreaming?: boolean };
      }
    ).compat;
    expect(compat?.supportsDeveloperRole).toBe(false);
    expect(compat?.supportsUsageInStreaming).toBe(false);
  });

  it("forces compat flags off for international DashScope compatible-mode endpoints", () => {
    const model = {
      id: "qwen-max",
      api: "openai-completions" as const,
      provider: "custom-dashscope-intl",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      name: "qwen-max",
    };

    const normalized = normalizeModelCompat(model);
    const compat = (
      normalized as {
        compat?: { supportsDeveloperRole?: boolean; supportsUsageInStreaming?: boolean };
      }
    ).compat;
    expect(compat?.supportsDeveloperRole).toBe(false);
    expect(compat?.supportsUsageInStreaming).toBe(false);
  });

  it("does not mutate the original model object", () => {
    const model = {
      id: "qwen3.5-plus",
      api: "openai-completions" as const,
      provider: "modelstudio",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      name: "qwen3.5-plus",
    };

    const normalized = normalizeModelCompat(model);
    expect(normalized).not.toBe(model);
    expect((model as { compat?: unknown }).compat).toBeUndefined();
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
