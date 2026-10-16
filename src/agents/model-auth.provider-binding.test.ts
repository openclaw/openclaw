import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as currentPluginMetadata from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { connectUserModelAccount } from "../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createApiKeyCredential as keyCredential,
  createAuthProfileStoreFixture as authStore,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./auth-profiles/path-resolve.native.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { resolveApiKeyForProviderCore as resolveAuth } from "./model-auth-provider.js";

beforeEach(() => {
  prepareSharedAuthStoreOwnershipForNative();
  clearRuntimeAuthProfileStoreSnapshots();
});
afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  vi.restoreAllMocks();
});
describe("explicit profile provider binding", () => {
  it("validates personal profile identity without requiring a shared-store credential", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-auth-pin-", agentEnv: "main" },
      async (state) => {
        const owner = ensureProfileForEmail("person@example.test");
        const { authProfileId } = connectUserModelAccount({
          ownerProfileId: owner.id,
          credential: keyCredential("personal-provider", "synthetic-personal-key"),
          assertCurrent() {},
        });
        const params = {
          profileId: authProfileId,
          lockedProfile: true,
          cfg: {},
          agentDir: state.agentDir(),
          store: authStore({}),
        };
        await expect(
          resolveAuth({ ...params, provider: "personal-provider" }),
        ).resolves.toMatchObject({ apiKey: "synthetic-personal-key", profileId: authProfileId });
        await expect(resolveAuth({ ...params, provider: "foreign-provider" })).rejects.toThrow(
          `Auth profile "${authProfileId}" is not compatible`,
        );
        expect(params.store.profiles).not.toHaveProperty(authProfileId);
      },
    );
  });

  it.each([false, true])(
    "rejects a foreign profile before resolving its secret (locked=%s)",
    async (lockedProfile) => {
      await expect(
        resolveAuth({
          provider: "target-provider",
          profileId: "foreign:default",
          lockedProfile,
          cfg: {
            models: {
              providers: {
                "target-provider": {
                  baseUrl: "https://target.example.test/v1",
                  models: [],
                  apiKey: "synthetic-config-fallback",
                },
              },
            },
          },
          store: authStore({
            "foreign:default": {
              type: "api_key",
              provider: "foreign-provider",
              keyRef: { source: "env", provider: "default", id: "UNMATERIALIZED_FOREIGN_KEY" },
            },
            "target:default": keyCredential("target-provider", "synthetic-compatible-key"),
          }),
        }),
      ).rejects.toThrow('Auth profile "foreign:default" is not compatible');
    },
  );

  it.each(["target-provider", "cloud-alias"])(
    "keeps compatible explicit %s profiles",
    async (provider) => {
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "target-provider",
            origin: "global",
            providerAuthAliases: { "cloud-alias": "target-provider" },
          },
        ],
      });
      const metadata = vi
        .spyOn(currentPluginMetadata, "getCurrentPluginMetadataSnapshot")
        .mockReturnValue(snapshot);
      try {
        await expect(
          resolveAuth({
            provider,
            profileId: "target:default",
            lockedProfile: true,
            cfg: {},
            store: authStore({
              "target:default": keyCredential("target-provider", "synthetic-selected-key"),
            }),
          }),
        ).resolves.toMatchObject({ apiKey: "synthetic-selected-key", profileId: "target:default" });
      } finally {
        metadata.mockRestore();
      }
    },
  );
});
