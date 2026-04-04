import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

function expectedCloudflareGatewayBaseUrl(accountId: string, gatewayId: string): string {
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`;
}

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

  it("keeps Cloudflare gateway metadata and apiKey from the same auth profile", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await writeFile(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "cloudflare-ai-gateway:key-only": {
              type: "api_key",
              provider: "cloudflare-ai-gateway",
              key: "sk-first",
            },
            "cloudflare-ai-gateway:gateway": {
              type: "api_key",
              provider: "cloudflare-ai-gateway",
              key: "sk-second",
              metadata: {
                accountId: "acct_456",
                gatewayId: "gateway_789",
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
    expect(providers?.["cloudflare-ai-gateway"]?.apiKey).toBe("sk-second");
    expect(providers?.["cloudflare-ai-gateway"]?.baseUrl).toBe(
      expectedCloudflareGatewayBaseUrl("acct_456", "gateway_789"),
    );
  });

  it("prefers the runtime env marker over stored profile secrets", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["CLOUDFLARE_AI_GATEWAY_API_KEY"]);
    process.env.CLOUDFLARE_AI_GATEWAY_API_KEY = "rotated-secret"; // pragma: allowlist secret

    await writeFile(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "cloudflare-ai-gateway:default": {
              type: "api_key",
              provider: "cloudflare-ai-gateway",
              key: "stale-stored-secret",
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
      expect(providers?.["cloudflare-ai-gateway"]?.baseUrl).toBe(
        expectedCloudflareGatewayBaseUrl("acct_123", "gateway_456"),
      );
    } finally {
      envSnapshot.restore();
    }
  });
});
