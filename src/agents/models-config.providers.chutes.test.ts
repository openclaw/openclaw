import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHUTES_BASE_URL } from "./chutes-models.js";
import { CHUTES_OAUTH_MARKER } from "./model-auth-markers.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

describe("chutes implicit provider auth mode", () => {
  it("keeps api_key-backed chutes profiles on the api-key loader path", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await writeFile(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "chutes:default": {
              type: "api_key",
              provider: "chutes",
              key: "chutes-live-api-key", // pragma: allowlist secret
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const providers = await resolveImplicitProvidersForTest({ agentDir, env: {} });
    expect(providers?.chutes?.baseUrl).toBe(CHUTES_BASE_URL);
    expect(providers?.chutes?.apiKey).toBe("chutes-live-api-key");
    expect(providers?.chutes?.apiKey).not.toBe(CHUTES_OAUTH_MARKER);
  });

  it("keeps api_key precedence when oauth profile is inserted first", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await writeFile(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "chutes:oauth": {
              type: "oauth",
              provider: "chutes",
              access: "oauth-access-token",
              refresh: "oauth-refresh-token",
              expires: Date.now() + 60_000,
            },
            "chutes:default": {
              type: "api_key",
              provider: "chutes",
              key: "chutes-live-api-key", // pragma: allowlist secret
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const providers = await resolveImplicitProvidersForTest({ agentDir, env: {} });
    expect(providers?.chutes?.baseUrl).toBe(CHUTES_BASE_URL);
    expect(providers?.chutes?.apiKey).toBe("chutes-live-api-key");
    expect(providers?.chutes?.apiKey).not.toBe(CHUTES_OAUTH_MARKER);
  });

  it("keeps api_key precedence when api_key profile is inserted first", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await writeFile(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "chutes:default": {
              type: "api_key",
              provider: "chutes",
              key: "chutes-live-api-key", // pragma: allowlist secret
            },
            "chutes:oauth": {
              type: "oauth",
              provider: "chutes",
              access: "oauth-access-token",
              refresh: "oauth-refresh-token",
              expires: Date.now() + 60_000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const providers = await resolveImplicitProvidersForTest({ agentDir, env: {} });
    expect(providers?.chutes?.baseUrl).toBe(CHUTES_BASE_URL);
    expect(providers?.chutes?.apiKey).toBe("chutes-live-api-key");
    expect(providers?.chutes?.apiKey).not.toBe(CHUTES_OAUTH_MARKER);
  });

  it("uses CHUTES_OAUTH_MARKER only for oauth-backed chutes profiles", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await writeFile(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "chutes:default": {
              type: "oauth",
              provider: "chutes",
              access: "oauth-access-token",
              refresh: "oauth-refresh-token",
              expires: Date.now() + 60_000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const providers = await resolveImplicitProvidersForTest({ agentDir, env: {} });
    expect(providers?.chutes?.baseUrl).toBe(CHUTES_BASE_URL);
    expect(providers?.chutes?.apiKey).toBe(CHUTES_OAUTH_MARKER);
  });
});
