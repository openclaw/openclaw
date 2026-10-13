import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLegacyPluginMetadataSnapshotRuntime } from "../../plugins/plugin-metadata-snapshot-required.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createProviderExternalAuthResolver } from "../../plugins/provider-external-auth-core.js";
import { createExternalAuthRuntime } from "./external-auth.js";
import { withLegacyExternalAuthPreparation } from "./external-auth.native.js";
import type { AuthProfileStore } from "./types.js";

vi.mock("../../plugins/plugin-metadata-snapshot-required.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-metadata-snapshot-required.js")>()),
  loadLegacyPluginMetadataSnapshotRuntime: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

describe("legacy external auth preparation", () => {
  it("prepares cold synchronous overlays and reads the store supplied by each write", () => {
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ id: "external-owner", contracts: { externalAuthProviders: ["custom"] } }],
    });
    vi.mocked(loadLegacyPluginMetadataSnapshotRuntime).mockReturnValue(snapshot);
    const hooks = vi.fn(() => [
      {
        id: "custom",
        label: "Custom",
        auth: [],
        resolveExternalAuthProfiles: ({ store }: { store: AuthProfileStore }) => [
          {
            profileId: "custom:external",
            credential: {
              type: "oauth" as const,
              provider: "custom",
              access: Object.keys(store.profiles).join(","),
              refresh: "synthetic-refresh",
              expires: 10_000,
            },
          },
        ],
      },
    ]);
    const resolver = createProviderExternalAuthResolver({
      resolveProviderPluginsForHooks: hooks,
      resolveProviderPluginsForHooksAsync: async () => [],
    });
    const runtime = withLegacyExternalAuthPreparation(
      createExternalAuthRuntime(
        resolver.resolveExternalAuthProfilesWithPlugins,
        resolver.prepareExternalAuthProfilesWithPlugins,
      ),
    );
    const store: AuthProfileStore = { version: 1, profiles: {} };
    expect(
      runtime.listRuntimeExternalAuthProfiles({
        store,
        externalCli: { externalCliProviderIds: [] },
      })[0]?.credential.access,
    ).toBe("");
    store.profiles.written = { type: "api_key", provider: "custom", key: "synthetic-key" };
    expect(
      runtime.overlayExternalAuthProfiles(store, { externalCliProviderIds: [] }).profiles[
        "custom:external"
      ],
    ).toMatchObject({ access: "written" });
    expect(hooks).toHaveBeenLastCalledWith(
      expect.objectContaining({ pluginMetadataSnapshot: snapshot }),
    );

    vi.mocked(loadLegacyPluginMetadataSnapshotRuntime).mockClear();
    runtime.listRuntimeExternalAuthProfiles({
      store,
      externalCli: { externalCliProviderIds: [], pluginMetadataSnapshot: snapshot },
    });
    expect(loadLegacyPluginMetadataSnapshotRuntime).not.toHaveBeenCalled();
  });
});
