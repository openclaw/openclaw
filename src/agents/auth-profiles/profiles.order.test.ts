import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORE_VERSION } from "./constants.js";
import { createApiKeyCredential, oauthCred } from "./credential-fixtures.test-support.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { withAuthProfileTestState } from "./profile-mutations.test-support.js";
import {
  clearLastGoodProfileWithLock,
  markAuthProfileSuccess,
  promoteAuthProfileInOrder,
  removeProviderAuthProfilesWithLock,
  setAuthProfileOrder,
} from "./profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { loadAuthProfileStoreForRuntime, saveAuthProfileStore } from "./store-runtime.js";
import type { AuthProfileStore } from "./types.js";

vi.mock("../provider-auth-aliases.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../provider-auth-aliases.js")>();
  return {
    ...actual,
    resolveProviderIdForAuth: (...args: Parameters<typeof actual.resolveProviderIdForAuth>) => {
      const provider = args[0].trim().toLowerCase();
      return provider === "gmi-cloud" || provider === "gmicloud"
        ? "gmi"
        : actual.resolveProviderIdForAuth(...args);
    },
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
});

describe("setAuthProfileOrder", () => {
  it("canonicalizes every alias-equivalent provider state mutation", async () => {
    await withAuthProfileTestState("openclaw-auth-alias-state-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const primary = "gmi:primary";
      const secondary = "gmi:secondary";
      const profiles = {
        [primary]: { type: "api_key" as const, provider: "gmi", key: "primary" },
        [secondary]: { type: "api_key" as const, provider: "gmi", key: "secondary" },
        "openai:other": { type: "api_key" as const, provider: "openai", key: "other" },
      };
      const seeded = (): AuthProfileStore => ({
        version: AUTH_STORE_VERSION,
        profiles,
        order: {
          "gmi-cloud": [primary],
          openai: ["openai:other"],
          gmicloud: [secondary],
        },
        lastGood: { gmicloud: secondary, openai: "openai:other", "gmi-cloud": primary },
      });

      saveAuthProfileStore(seeded(), agentDir);
      clearRuntimeAuthProfileStoreSnapshots();
      await setAuthProfileOrder({ agentDir, provider: "gmi-cloud", order: [secondary] });
      expect(loadPersistedAuthProfileStore(agentDir)?.order).toEqual({
        openai: ["openai:other"],
        gmi: [secondary],
      });
      saveAuthProfileStore(
        {
          ...seeded(),
          order: { ...seeded().order, gmi: [primary] },
        },
        agentDir,
      );
      clearRuntimeAuthProfileStoreSnapshots();
      await setAuthProfileOrder({ agentDir, provider: "gmi-cloud", order: null });
      expect(loadPersistedAuthProfileStore(agentDir)?.order).toEqual({
        openai: ["openai:other"],
      });

      saveAuthProfileStore(
        {
          ...seeded(),
          order: { ...seeded().order, "gmi-cloud": [secondary, primary] },
        },
        agentDir,
      );
      clearRuntimeAuthProfileStoreSnapshots();
      await promoteAuthProfileInOrder({ agentDir, provider: "gmi-cloud", profileId: secondary });
      expect(loadPersistedAuthProfileStore(agentDir)?.order).toEqual({
        openai: ["openai:other"],
        gmi: [secondary, primary],
      });

      saveAuthProfileStore(seeded(), agentDir);
      clearRuntimeAuthProfileStoreSnapshots();
      await clearLastGoodProfileWithLock({ agentDir, provider: "gmi-cloud", profileId: secondary });
      expect(loadPersistedAuthProfileStore(agentDir)?.lastGood).toEqual({
        openai: "openai:other",
      });

      saveAuthProfileStore(seeded(), agentDir);
      clearRuntimeAuthProfileStoreSnapshots();
      const runtimeStore = loadAuthProfileStoreForRuntime(agentDir);
      await markAuthProfileSuccess({
        agentDir,
        profileId: secondary,
        provider: "gmi-cloud",
        store: runtimeStore,
      });
      expect(loadPersistedAuthProfileStore(agentDir)?.lastGood).toEqual({
        openai: "openai:other",
        gmi: secondary,
      });

      saveAuthProfileStore(seeded(), agentDir);
      clearRuntimeAuthProfileStoreSnapshots();
      await removeProviderAuthProfilesWithLock({ agentDir, provider: "gmi-cloud" });
      expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject({
        profiles: { "openai:other": expect.any(Object) },
        order: { openai: ["openai:other"] },
        lastGood: { openai: "openai:other" },
      });
    });
  });

  it("preserves inherited main OAuth profile IDs in a secondary agent order without copying credentials", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-order-set-inherited-",
      async ({ agentDirFor }) => {
        const mainAgentDir = agentDirFor("main");
        const customAgentDir = agentDirFor("custom");
        fs.mkdirSync(mainAgentDir, { recursive: true });
        fs.mkdirSync(customAgentDir, { recursive: true });
        // Main agent owns two OAuth profiles; the secondary agent inherits them
        // at runtime and has no local credential copies.
        const mainStore = (): AuthProfileStore => ({
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:profile-a": oauthCred({
              provider: "openai",
              access: "access-a",
              refresh: "refresh-a",
              expires: Date.now() + 60_000,
            }),
            "openai:profile-b": oauthCred({
              provider: "openai",
              access: "access-b",
              refresh: "refresh-b",
              expires: Date.now() + 60_000,
            }),
          },
          order: { openai: ["openai:profile-a"] },
        });
        saveAuthProfileStore(mainStore());

        // The secondary agent selects the other inherited profile ID. Before the
        // fix, the local save pruned this ID because the secondary store does
        // not own the OAuth credential, so `order get` fell back to main's
        // profile-a (issue #119233).
        const updated = await setAuthProfileOrder({
          agentDir: customAgentDir,
          provider: "openai",
          order: ["openai:profile-b"],
        });

        expect(updated?.order?.openai).toEqual(["openai:profile-b"]);
        // Reload from persistence: the inherited ID must survive, not be pruned.
        expect(loadPersistedAuthProfileStore(customAgentDir)?.order?.openai).toEqual([
          "openai:profile-b",
        ]);
        // The runtime store for the secondary agent reflects the local override.
        expect(loadAuthProfileStoreForRuntime(customAgentDir).order?.openai).toEqual([
          "openai:profile-b",
        ]);
        // The secondary agent must not gain a local copy of the inherited OAuth
        // credential — only the order reference is preserved.
        const persistedCustom = loadPersistedAuthProfileStore(customAgentDir);
        expect(persistedCustom?.profiles["openai:profile-b"]).toBeUndefined();
        expect(persistedCustom?.profiles["openai:profile-a"]).toBeUndefined();
      },
      { clearOAuthDir: true },
    );
  });

  it("clears a provider order without preserving any profile IDs", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-order-set-clear-",
      async ({ agentDir }) => {
        fs.mkdirSync(agentDir, { recursive: true });
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:local": createApiKeyCredential("openai", "sk-local"),
          },
          order: { openai: ["openai:local"] },
        });

        const updated = await setAuthProfileOrder({
          agentDir,
          provider: "openai",
          order: null,
        });

        expect(updated?.order?.openai ?? null).toBeNull();
        expect(loadPersistedAuthProfileStore(agentDir)?.order?.openai ?? null).toBeNull();
      },
      { clearOAuthDir: true },
    );
  });
});
