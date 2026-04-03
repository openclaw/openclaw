import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

describe("vercel-ai-gateway provider resolution", () => {
  it("adds the provider when AI_GATEWAY_API_KEY is present", async () => {
    const envSnapshot = captureEnv(["AI_GATEWAY_API_KEY"]);
    process.env.AI_GATEWAY_API_KEY = "vercel-gateway-test-key"; // pragma: allowlist secret
    try {
      const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      const provider = providers?.["vercel-ai-gateway"];
      expect(provider).toBeDefined();
      expect(provider?.apiKey).toBe("AI_GATEWAY_API_KEY");
    } finally {
      envSnapshot.restore();
    }
  });

  it("prefers env keyRef marker over runtime plaintext for persistence", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["AI_GATEWAY_API_KEY"]);
    delete process.env.AI_GATEWAY_API_KEY;

    await writeFile(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "vercel-ai-gateway:default": {
              type: "api_key",
              provider: "vercel-ai-gateway",
              key: "sk-runtime-vercel",
              keyRef: { source: "env", provider: "default", id: "AI_GATEWAY_API_KEY" },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.["vercel-ai-gateway"]?.apiKey).toBe("AI_GATEWAY_API_KEY");
    } finally {
      envSnapshot.restore();
    }
  });

  it("uses non-env marker for non-env keyRef vercel profiles", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await writeFile(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "vercel-ai-gateway:default": {
              type: "api_key",
              provider: "vercel-ai-gateway",
              key: "sk-runtime-vercel",
              keyRef: { source: "file", provider: "vault", id: "/vercel/ai-gateway/api-key" },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const providers = await resolveImplicitProvidersForTest({ agentDir });
    expect(providers?.["vercel-ai-gateway"]?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
  });
});
