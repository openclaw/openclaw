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

function createTempAgentDir() {
  return mkdtempSync(join(tmpdir(), "openclaw-test-"));
}

type ChutesAuthProfiles = {
  [profileId: string]:
    | {
        type: "api_key";
        provider: "chutes";
        key: string;
      }
    | {
        type: "oauth";
        provider: "chutes";
        access: string;
        refresh: string;
        expires: number;
      };
};

function createChutesApiKeyProfile(key = "chutes-live-api-key") {
  return {
    type: "api_key" as const,
    provider: "chutes" as const,
    key,
  };
}

function createChutesOAuthProfile(access = "oauth-access-token") {
  return {
    type: "oauth" as const,
    provider: "chutes" as const,
    access,
    refresh: "oauth-refresh-token",
    expires: Date.now() + 60_000,
  };
}

async function writeChutesAuthProfiles(agentDir: string, profiles: ChutesAuthProfiles) {
  await writeFile(
    join(agentDir, "auth-profiles.json"),
    JSON.stringify(
      {
        version: 1,
        profiles,
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function resolveChutesProvidersForProfiles(
  profiles: ChutesAuthProfiles,
  env: NodeJS.ProcessEnv = {},
) {
  const agentDir = createTempAgentDir();
  await writeChutesAuthProfiles(agentDir, profiles);
  return await resolveImplicitProvidersForTest({ agentDir, env });
}

function expectChutesApiKeyProvider(
  providers: Awaited<ReturnType<typeof resolveImplicitProvidersForTest>>,
  apiKey = "chutes-live-api-key",
) {
  expect(providers?.chutes?.baseUrl).toBe(CHUTES_BASE_URL);
  expect(providers?.chutes?.apiKey).toBe(apiKey);
  expect(providers?.chutes?.apiKey).not.toBe(CHUTES_OAUTH_MARKER);
}

function expectChutesOAuthMarkerProvider(
  providers: Awaited<ReturnType<typeof resolveImplicitProvidersForTest>>,
) {
  expect(providers?.chutes?.baseUrl).toBe(CHUTES_BASE_URL);
  expect(providers?.chutes?.apiKey).toBe(CHUTES_OAUTH_MARKER);
}

async function withRealChutesDiscovery<T>(
  run: (fetchMock: ReturnType<typeof vi.fn>) => Promise<T>,
) {
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
    return await run(fetchMock);
  } finally {
    process.env.VITEST = originalVitest;
    process.env.NODE_ENV = originalNodeEnv;
    globalThis.fetch = originalFetch;
  }
}

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
    const agentDir = createTempAgentDir();
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
    const providers = await resolveChutesProvidersForProfiles({
      "chutes:default": createChutesApiKeyProfile(),
    });
    expectChutesApiKeyProvider(providers);
  });

  it("keeps api_key precedence when oauth profile is inserted first", async () => {
    const providers = await resolveChutesProvidersForProfiles({
      "chutes:oauth": createChutesOAuthProfile(),
      "chutes:default": createChutesApiKeyProfile(),
    });
    expectChutesApiKeyProvider(providers);
  });

  it("keeps api_key precedence when api_key profile is inserted first", async () => {
    const providers = await resolveChutesProvidersForProfiles({
      "chutes:default": createChutesApiKeyProfile(),
      "chutes:oauth": createChutesOAuthProfile(),
    });
    expectChutesApiKeyProvider(providers);
  });

  it("forwards oauth access token to chutes model discovery", async () => {
    await withRealChutesDiscovery(async (fetchMock) => {
      const providers = await resolveChutesProvidersForProfiles({
        "chutes:default": createChutesOAuthProfile("my-chutes-access-token"),
      });
      expectChutesOAuthMarkerProvider(providers);
      const chutesCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("chutes.ai"));
      expect(chutesCalls.length).toBeGreaterThan(0);
      const request = chutesCalls[0]?.[1] as { headers?: Record<string, string> } | undefined;
      expect(request?.headers?.Authorization).toBe("Bearer my-chutes-access-token");
    });
  });

  it("uses CHUTES_OAUTH_MARKER only for oauth-backed chutes profiles", async () => {
    const providers = await resolveChutesProvidersForProfiles({
      "chutes:default": createChutesOAuthProfile(),
    });
    expectChutesOAuthMarkerProvider(providers);
  });
});
