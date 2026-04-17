import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAuthProfileOrder } from "./order.js";
import { markAuthProfileGood } from "./profiles.js";
import { saveAuthProfileStore } from "./store.js";
import type { AuthProfileStore } from "./types.js";

const loadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn(() => ({
    plugins: [
      {
        id: "fixture-provider",
        providerAuthAliases: { "fixture-provider-plan": "fixture-provider" },
      },
    ],
    diagnostics: [],
  })),
);

vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

vi.mock("./external-auth.js", () => ({
  overlayExternalAuthProfiles: <T>(store: T) => store,
  shouldPersistExternalAuthProfile: () => true,
}));

describe("resolveAuthProfileOrder", () => {
  beforeEach(() => {
    loadPluginManifestRegistry.mockClear();
  });

  it("accepts aliased provider credentials from manifest metadata", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "fixture-provider:default": {
          type: "api_key",
          provider: "fixture-provider",
          key: "sk-test",
        },
      },
    };

    const order = resolveAuthProfileOrder({
      store,
      provider: "fixture-provider-plan",
    });

    expect(order).toEqual(["fixture-provider:default"]);
  });

  it("marks aliased provider profiles good under the canonical auth provider", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-auth-profile-alias-"));
    try {
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          "fixture-provider:default": {
            type: "api_key",
            provider: "fixture-provider",
            key: "sk-test",
          },
        },
      };
      saveAuthProfileStore(store, agentDir);

      await markAuthProfileGood({
        store,
        provider: "fixture-provider-plan",
        profileId: "fixture-provider:default",
        agentDir,
      });

      expect(store.lastGood).toEqual({
        "fixture-provider": "fixture-provider:default",
      });
    } finally {
      await rm(agentDir, { force: true, recursive: true });
    }
  });
});
