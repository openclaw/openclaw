import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";
import { buildAinftProvider } from "./models-config.providers.js";

const AINFT_BASE_URL = "https://chat.ainft.com/webapi/";
const AINFT_MODEL_IDS = [
  "gpt-5.2",
  "gpt-5-mini",
  "gpt-5-nano",
  "claude-opus-4.6",
  "claude-sonnet-4.6",
  "claude-haiku-4.5",
];

describe("AINFT implicit provider", () => {
  it("should include ainft when AINFT_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["AINFT_API_KEY"]);
    process.env.AINFT_API_KEY = "test-ainft-key"; // pragma: allowlist secret

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.ainft).toBeDefined();
      expect(providers?.ainft?.models?.length).toBeGreaterThan(0);
    } finally {
      envSnapshot.restore();
    }
  });

  it("should not include ainft when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["AINFT_API_KEY"]);
    delete process.env.AINFT_API_KEY;

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.ainft).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });

  it("should build ainft provider with correct configuration", () => {
    const provider = buildAinftProvider();
    expect(provider.baseUrl).toBe(AINFT_BASE_URL);
    expect(provider.api).toBe("openai-completions");
    expect(provider.models).toBeDefined();
    expect(provider.models.length).toBeGreaterThan(0);
  });

  it("should include all expected ainft models", () => {
    const provider = buildAinftProvider();
    const modelIds = provider.models.map((m) => m.id);
    for (const modelId of AINFT_MODEL_IDS) {
      expect(modelIds).toContain(modelId);
    }
    expect(provider.models).toHaveLength(AINFT_MODEL_IDS.length);
  });

  it("should set gpt-5.2 as the default (first) model", () => {
    const provider = buildAinftProvider();
    expect(provider.models[0].id).toBe("gpt-5.2");
  });
});
