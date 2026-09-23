import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { testApi as loggerTestApi } from "../logging/logger.test-support.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import {
  normalizePluginDiscoveryResult,
  runProviderCatalog,
} from "../plugins/provider-discovery.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { registerResolvedAgentDir, unregisterResolvedAgentDir } from "./agent-dir-registry.js";
import {
  createAuthProfileStoreFixture,
  oauthCred,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { OAuthRefreshFailureError } from "./auth-profiles/oauth-refresh-failure.js";
import { resolveApiKeyForProfile } from "./auth-profiles/oauth.js";
import { prepareProviderCatalogRun } from "./models-config.providers.catalog-context.js";
import type { ProviderAuthResolver } from "./models-config.providers.secret-helpers.js";

vi.mock("./auth-profiles/oauth.js", () => ({ resolveApiKeyForProfile: vi.fn() }));
vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: (provider: string) => provider,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await loggerTestApi.flushFileLogQueueForTests();
  setLoggerOverride(null);
  resetLogger();
  vi.clearAllMocks();
});

it.each([true, false])(
  "reports failed OAuth preparation with the resulting catalog (API-key fallback: %s)",
  async (withApiKey) => {
    const agentDir = tempDirs.make("catalog-oauth-diagnostic-");
    const logFile = path.join(agentDir, "catalog.log");
    const profileId = "fixture:owner";
    const refresh = "synthetic-refresh-secret-that-must-not-be-logged";
    const store = createAuthProfileStoreFixture({
      [profileId]: oauthCred({
        provider: "fixture",
        access: "expired-access",
        refresh,
        expires: 1,
      }),
    });
    const selectedCredentials: Array<string | undefined> = [];
    const provider: ProviderPlugin = {
      id: "fixture",
      label: "Fixture",
      auth: [{ id: "oauth", label: "OAuth", kind: "oauth", run: async () => ({ profiles: [] }) }],
      catalog: {
        run: async (ctx) => {
          const auth = ctx.resolveProviderAuth();
          if (auth.preparationFailed) {
            return null;
          }
          selectedCredentials.push(auth.discoveryApiKey);
          return {
            provider: {
              baseUrl: `https://catalog.example.test/v1?api_key=${refresh}`,
              models: [],
            },
          };
        },
      },
    };
    vi.mocked(resolveApiKeyForProfile).mockRejectedValue(
      new OAuthRefreshFailureError({
        provider: "fixture",
        profileId,
        message: `invalid_grant refresh_token=${refresh}`,
      }),
    );
    const outcomes: ProviderCatalogOutcome[] = [];
    await fs.writeFile(logFile, "");
    setLoggerOverride({ file: logFile, level: "warn", consoleLevel: "silent" });
    const resolveAuth: ProviderAuthResolver = (_provider, options) =>
      options?.excludeProfileIds?.includes(profileId)
        ? {
            apiKey: withApiKey ? "fallback-api-key" : undefined,
            discoveryApiKey: withApiKey ? "fallback-api-key" : undefined,
            mode: withApiKey ? "api_key" : "none",
            source: "none",
          }
        : { apiKey: undefined, mode: "oauth", source: "profile", profileId };
    const directoryOwner = { agentId: withApiKey ? "worker" : "main", agentDir };
    registerResolvedAgentDir(directoryOwner);
    try {
      const prepared = await prepareProviderCatalogRun({
        provider,
        config: {},
        agentDir,
        authStore: store,
        env: {},
        isActive: () => true,
        resolveProviderAuth: (providerId, options) =>
          resolveAuth(providerId ?? provider.id, options),
        resolveProviderApiKey: () => ({ apiKey: withApiKey ? "fallback-api-key" : undefined }),
        reportCatalogOutcome: (outcome) => outcomes.push(outcome),
      });
      const result = await runProviderCatalog(prepared);
      const finalized = prepared.finalizeCatalogResult?.(result) ?? result;
      const providers = normalizePluginDiscoveryResult({ provider, result: finalized });
      await loggerTestApi.flushFileLogQueueForTests();
      const records = (await fs.readFile(logFile, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const diagnostics = records.filter((record) =>
        String(record["0"]).includes("agents/model-providers"),
      );
      expect(diagnostics).toHaveLength(1);
      const diagnostic = String(diagnostics[0]?.["1"]);
      expect(diagnostic).toContain(profileId);
      expect(diagnostic).toContain("invalid_grant");
      expect(diagnostic).toContain("models auth login --provider fixture");
      expect(diagnostic).toContain(`--agent '${directoryOwner.agentId}'`);
      expect(diagnostic).toContain(`--profile-id '${profileId}'`);
      expect(diagnostic).not.toContain(refresh);
      if (withApiKey) {
        expect(selectedCredentials).toEqual(["fallback-api-key"]);
        expect(providers.fixture?.baseUrl).toBe(
          `https://catalog.example.test/v1?api_key=${refresh}`,
        );
        expect(diagnostic).toContain("https://catalog.example.test");
        expect(outcomes).toEqual([]);
      } else {
        expect(selectedCredentials).toEqual([]);
        expect(providers).toEqual({});
        expect(outcomes).toEqual([{ provider: "fixture", profileId, status: "unavailable" }]);
      }
    } finally {
      unregisterResolvedAgentDir(directoryOwner);
    }
  },
);
