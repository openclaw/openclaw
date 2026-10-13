import { afterEach, describe, expect, it, vi } from "vitest";
import { externalCliDiscoveryScoped } from "./auth-profiles/external-cli-discovery.js";
import { loadPersistedAuthProfileStore } from "./auth-profiles/persisted.js";
import { apiKeyStore, withAgentDirEnv } from "./auth-profiles/sqlite.test-support.js";
import {
  loadAuthProfileStoreForRuntime,
  saveAuthProfileStore,
} from "./auth-profiles/store-runtime.js";

const { resolveExternalAuthProfilesWithPluginsMock } = vi.hoisted(() => ({
  resolveExternalAuthProfilesWithPluginsMock: vi.fn(() => [
    {
      profileId: "minimax-portal:default",
      credential: {
        type: "oauth" as const,
        provider: "minimax-portal",
        access: "access-token",
        refresh: "refresh-token",
        expires: 4_102_444_800_000,
      },
      persistence: "runtime-only" as const,
    },
  ]),
}));
vi.mock("../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: resolveExternalAuthProfilesWithPluginsMock,
  }),
}));
afterEach(() => vi.clearAllMocks());

describe("read-only external auth overlay", () => {
  it("passes discovery scope to the provider and keeps its overlay out of SQLite", async () => {
    await withAgentDirEnv("openclaw-auth-readonly-", (agentDir) => {
      const baseline = apiKeyStore("sk-test");
      saveAuthProfileStore(baseline, agentDir, {
        filterExternalAuthProfiles: false,
        syncExternalCli: false,
      });
      const profileId = "minimax-portal:default";
      const config = {
        auth: {
          profiles: {
            [profileId]: {
              provider: "minimax-portal",
              mode: "oauth" as const,
            },
          },
        },
      };
      const read = () =>
        loadAuthProfileStoreForRuntime(agentDir, {
          readOnly: true,
          externalCli: externalCliDiscoveryScoped({
            config,
            providerIds: ["minimax-portal"],
            profileIds: [profileId],
          }),
        });
      const loaded = read();
      expect(resolveExternalAuthProfilesWithPluginsMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          config,
          context: expect.objectContaining({
            config,
            agentDir,
            store: expect.objectContaining(baseline),
          }),
        }),
      );
      expect(loaded.profiles[profileId]).toMatchObject({
        type: "oauth",
        provider: "minimax-portal",
        access: "access-token",
      });
      resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
        {
          profileId,
          credential: {
            type: "oauth",
            provider: "minimax-portal",
            access: "refreshed-access",
            refresh: "refreshed-refresh",
            expires: 4_102_444_800_000,
          },
          persistence: "runtime-only",
        },
      ]);
      expect(read().profiles[profileId]).toMatchObject({ access: "refreshed-access" });
      expect(resolveExternalAuthProfilesWithPluginsMock).toHaveBeenCalledTimes(2);
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles).toEqual(baseline.profiles);
    });
  });
});
