import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../plugin-sdk/file-lock.js";
import { isPluginRegistryLoadInFlight } from "../plugins/loader-cache.js";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { oauthCred } from "./auth-profiles/credential-fixtures.test-support.js";
import { readAuthProfileStoreForTest, storeWith } from "./auth-profiles/oauth-test-utils.js";
import { resolveApiKeyForProfile } from "./auth-profiles/oauth.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";

const provider = "lifecycle-provider";
const profileId = `${provider}:default`;

function reset() {
  clearRuntimeAuthProfileStoreSnapshots();
  resetFileLockStateForTest();
  resetPluginLoaderTestStateForTest();
}
beforeEach(reset);
afterEach(reset);
afterAll(cleanupPluginLoaderFixturesForTest);

it("resumes OAuth refresh after synchronous provider registration completes", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-provider-refresh-", agentEnv: "main" },
    async (state) => {
      const expired = oauthCred({ provider, access: "old", refresh: "old", expires: 1 });
      const store = storeWith(profileId, expired);
      await state.writeAuthProfiles(store);
      useNoBundledPlugins();
      const plugin = writePlugin({
        id: "provider-refresh-lifecycle",
        registration: `
          api.logger.info("registration-start");
          api.registerProvider({
            id: ${JSON.stringify(provider)},
            label: "Lifecycle Provider",
            auth: [],
            async refreshOAuth(credential) {
              return { ...credential, access: "access-new", refresh: "refresh-new", expires: 4102444800000 };
            },
          });
        `,
      });
      fs.writeFileSync(
        path.join(plugin.dir, "openclaw.plugin.json"),
        JSON.stringify({ id: plugin.id, providers: [provider], configSchema: EMPTY_PLUGIN_SCHEMA }),
        "utf8",
      );
      const load: NonNullable<Parameters<typeof loadOpenClawPlugins>[0]> = {
        cache: false,
        workspaceDir: plugin.dir,
        config: {
          plugins: {
            allow: [plugin.id],
            load: { paths: [plugin.file] },
            entries: { [plugin.id]: { enabled: true } },
          },
        },
        onlyPluginIds: [plugin.id],
      };
      let refresh: ReturnType<typeof resolveApiKeyForProfile> | undefined;
      const startRefresh = vi.fn(() => {
        expect(isPluginRegistryLoadInFlight(load)).toBe(true);
        refresh = resolveApiKeyForProfile({ cfg: load.config, store, profileId });
      });
      loadOpenClawPlugins({
        ...load,
        logger: { info: startRefresh, warn: vi.fn(), error: vi.fn() },
      });
      expect(isPluginRegistryLoadInFlight(load)).toBe(false);
      if (!refresh) {
        throw new Error("provider lifecycle fixture did not start auth resolution");
      }
      await expect(refresh).resolves.toMatchObject({ apiKey: "access-new" });
      expect(readAuthProfileStoreForTest(state.agentDir()).profiles[profileId]).toEqual({
        ...expired,
        access: "access-new",
        refresh: "refresh-new",
        expires: 4_102_444_800_000,
      });
      expect(startRefresh).toHaveBeenCalledOnce();
    },
  );
});
