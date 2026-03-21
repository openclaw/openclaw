import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHUTES_BASE_URL } from "./chutes-models.js";
import { resolveOAuthApiKeyMarker } from "./model-auth-markers.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";
import { resolveImplicitProviders } from "./models-config.providers.js";

const CHUTES_OAUTH_MARKER = resolveOAuthApiKeyMarker("chutes");
const ORIGINAL_VITEST_ENV = process.env.VITEST;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe("chutes implicit provider auth mode", () => {
  beforeEach(() => {
    process.env.VITEST = "true";
    process.env.NODE_ENV = "test";
  });

  afterAll(() => {
    process.env.VITEST = ORIGINAL_VITEST_ENV;
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it("auto-loads bundled chutes discovery for env api keys", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProviders({
      agentDir,
      env: {
        CHUTES_API_KEY: "env-chutes-api-key",
      } as NodeJS.ProcessEnv,
    });

    expect(providers?.chutes?.baseUrl).toBe(CHUTES_BASE_URL);
    expect(providers?.chutes?.apiKey).toBe("CHUTES_API_KEY");
  });

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

  it("forwards oauth access token to chutes model discovery", async () => {
    // Enable real discovery so fetch is actually called.
    const originalVitest = process.env.VITEST;
    const originalNodeEnv = process.env.NODE_ENV;
    const originalFetch = globalThis.fetch;
    delete process.env.VITEST;
    delete process.env.NODE_ENV;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "chutes/private-model" }] }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
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
                access: "my-chutes-access-token",
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
      expect(providers?.chutes?.apiKey).toBe(CHUTES_OAUTH_MARKER);

      const chutesCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("chutes.ai"));
      expect(chutesCalls.length).toBeGreaterThan(0);
      const request = chutesCalls[0]?.[1] as { headers?: Record<string, string> } | undefined;
      expect(request?.headers?.Authorization).toBe("Bearer my-chutes-access-token");
    } finally {
      process.env.VITEST = originalVitest;
      process.env.NODE_ENV = originalNodeEnv;
      globalThis.fetch = originalFetch;
    }
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
