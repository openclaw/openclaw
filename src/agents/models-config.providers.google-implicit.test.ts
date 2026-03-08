import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

describe("google implicit provider via GEMINI_API_KEY", () => {
  it("activates the google provider when GEMINI_API_KEY is set", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await writeFile(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "google:default": {
              type: "api_key",
              provider: "google",
              key: "test-gemini-key", // pragma: allowlist secret
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const providers = await resolveImplicitProvidersForTest({ agentDir });
    expect(providers).toHaveProperty("google");
    expect(providers?.google).toMatchObject({
      baseUrl: "https://generativelanguage.googleapis.com",
      api: "google-generative-ai",
    });
    // The implicit loader uses models: [] to avoid overriding the built-in catalog
    expect(providers?.google?.models ?? []).toEqual([]);
  });

  it("does not activate google provider without credentials", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await writeFile(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify({ version: 1, profiles: {} }, null, 2),
      "utf8",
    );

    const providers = await resolveImplicitProvidersForTest({ agentDir });
    // Google should not appear when there are no credentials
    expect(providers?.google).toBeUndefined();
  });
});
