import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { upsertAuthProfile } from "./auth-profiles.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

const VOLC_SHARED_IMAGE_MODELS = [
  "ark-code-latest",
  "doubao-seed-code",
  "glm-4.7",
  "kimi-k2-thinking",
  "kimi-k2.5",
] as const;

function expectSharedCodingVisionCapabilities(
  models: { id: string; input?: string[] }[] | undefined,
) {
  expect(models).toBeDefined();

  for (const modelId of VOLC_SHARED_IMAGE_MODELS) {
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: modelId,
          input: expect.arrayContaining(["image"]),
        }),
      ]),
    );
  }
}

describe("Volcengine and BytePlus providers", () => {
  it("includes volcengine and volcengine-plan when VOLCANO_ENGINE_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["VOLCANO_ENGINE_API_KEY"]);
    process.env.VOLCANO_ENGINE_API_KEY = "test-key"; // pragma: allowlist secret

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.volcengine).toBeDefined();
      expect(providers?.["volcengine-plan"]).toBeDefined();
      expect(providers?.volcengine?.apiKey).toBe("VOLCANO_ENGINE_API_KEY");
      expect(providers?.["volcengine-plan"]?.apiKey).toBe("VOLCANO_ENGINE_API_KEY");
      expectSharedCodingVisionCapabilities(providers?.["volcengine-plan"]?.models);
    } finally {
      envSnapshot.restore();
    }
  });

  it("includes byteplus and byteplus-plan when BYTEPLUS_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["BYTEPLUS_API_KEY"]);
    process.env.BYTEPLUS_API_KEY = "test-key"; // pragma: allowlist secret

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.byteplus).toBeDefined();
      expect(providers?.["byteplus-plan"]).toBeDefined();
      expect(providers?.byteplus?.apiKey).toBe("BYTEPLUS_API_KEY");
      expect(providers?.["byteplus-plan"]?.apiKey).toBe("BYTEPLUS_API_KEY");
      expectSharedCodingVisionCapabilities(providers?.["byteplus-plan"]?.models);
    } finally {
      envSnapshot.restore();
    }
  });

  it("includes providers when auth profiles are env keyRef-only", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["VOLCANO_ENGINE_API_KEY", "BYTEPLUS_API_KEY"]);
    delete process.env.VOLCANO_ENGINE_API_KEY;
    delete process.env.BYTEPLUS_API_KEY;

    upsertAuthProfile({
      profileId: "volcengine:default",
      credential: {
        type: "api_key",
        provider: "volcengine",
        keyRef: { source: "env", provider: "default", id: "VOLCANO_ENGINE_API_KEY" },
      },
      agentDir,
    });
    upsertAuthProfile({
      profileId: "byteplus:default",
      credential: {
        type: "api_key",
        provider: "byteplus",
        keyRef: { source: "env", provider: "default", id: "BYTEPLUS_API_KEY" },
      },
      agentDir,
    });

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.volcengine?.apiKey).toBe("VOLCANO_ENGINE_API_KEY");
      expect(providers?.["volcengine-plan"]?.apiKey).toBe("VOLCANO_ENGINE_API_KEY");
      expect(providers?.byteplus?.apiKey).toBe("BYTEPLUS_API_KEY");
      expect(providers?.["byteplus-plan"]?.apiKey).toBe("BYTEPLUS_API_KEY");
    } finally {
      envSnapshot.restore();
    }
  });
});
