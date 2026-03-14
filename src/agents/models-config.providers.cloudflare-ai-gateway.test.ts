import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

describe("cloudflare-ai-gateway profile provenance", () => {
  it("prefers env keyRef marker over runtime plaintext for persistence", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["CLOUDFLARE_AI_GATEWAY_API_KEY"]);
    delete process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;

    await writeFile(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "cloudflare-ai-gateway:default": {
              type: "api_key",
              provider: "cloudflare-ai-gateway",
              key: "sk-runtime-cloudflare",
              keyRef: { source: "env", provider: "default", id: "CLOUDFLARE_AI_GATEWAY_API_KEY" },
              metadata: {
                accountId: "acct_123",
                gatewayId: "gateway_456",
              },
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
      expect(providers?.["cloudflare-ai-gateway"]?.apiKey).toBe("CLOUDFLARE_AI_GATEWAY_API_KEY");
    } finally {
      envSnapshot.restore();
    }
  });

  it("uses non-env marker for non-env keyRef cloudflare profiles", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await writeFile(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "cloudflare-ai-gateway:default": {
              type: "api_key",
              provider: "cloudflare-ai-gateway",
              key: "sk-runtime-cloudflare",
              keyRef: { source: "file", provider: "vault", id: "/cloudflare/apiKey" },
              metadata: {
                accountId: "acct_123",
                gatewayId: "gateway_456",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const providers = await resolveImplicitProvidersForTest({ agentDir });
    expect(providers?.["cloudflare-ai-gateway"]?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
  });
});
