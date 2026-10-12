import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAuthProfileSecretOwnerId } from "../../secrets/runtime-auth-profile-owner.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { createAuthProfileStoreFixture } from "./credential-fixtures.test-support.js";
import type { AuthProfileCredential, AuthProfileStore, RuntimeAuthProfileStore } from "./types.js";

vi.hoisted(() => {
  vi.resetModules();
});
const resolveProviderOAuthCredentialWithPlugin = vi.hoisted(() =>
  vi.fn(async () => ({ status: "unhandled" as const })),
);
vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
}));
vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  buildProviderAuthDoctorHintWithPlugin: async () => undefined,
  formatProviderAuthProfileApiKeyWithPlugin: async (params: { context?: { access?: string } }) =>
    params.context?.access,
  resolveProviderOAuthCredentialWithPlugin,
  resolveProviderOAuthRefreshCapabilityWithPlugin: async () => ({ status: "unhandled" }),
}));

let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;
let clearRuntimeAuthProfileStoreSnapshots: typeof import("./runtime-snapshots.js").clearRuntimeAuthProfileStoreSnapshots;
let setRuntimeAuthProfileStoreSnapshot: typeof import("./runtime-snapshots.js").setRuntimeAuthProfileStoreSnapshot;
beforeAll(async () => {
  ({ resolveApiKeyForProfile } = await import("./oauth.js"));
  ({ clearRuntimeAuthProfileStoreSnapshots, setRuntimeAuthProfileStoreSnapshot } =
    await import("./runtime-snapshots.js"));
});
beforeEach(() => {
  resolveProviderOAuthCredentialWithPlugin.mockClear();
  clearRuntimeAuthProfileStoreSnapshots();
  setActiveDegradedSecretOwners([]);
});
afterAll(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  setActiveDegradedSecretOwners([]);
  vi.doUnmock("../cli-credentials.js");
  vi.doUnmock("../../plugins/provider-runtime.runtime.js");
  vi.resetModules();
});

function cfgFor(profileId: string, provider: string, mode: "api_key" | "token" | "oauth") {
  return { auth: { profiles: { [profileId]: { provider, mode } } } } satisfies OpenClawConfig;
}
function resolveCredential(
  credential: AuthProfileCredential,
  mode = credential.type,
  provider = credential.provider,
) {
  const profileId = "fixture:default";
  return resolveApiKeyForProfile({
    cfg: cfgFor(profileId, provider, mode),
    store: createAuthProfileStoreFixture({ [profileId]: credential }),
    profileId,
  });
}

describe("resolveApiKeyForProfile", () => {
  it("rejects a persisted Claude CLI token", async () => {
    const profileId = "anthropic:claude-cli";
    const store: RuntimeAuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "anthropic",
          access: "copied-native-access",
          refresh: "copied-native-refresh",
          expires: Date.now() + 3_600_000,
        },
      },
      runtimePersistedProfileIds: [profileId],
    };
    await expect(
      resolveApiKeyForProfile({
        cfg: cfgFor(profileId, "anthropic", "oauth"),
        store,
        profileId,
      }),
    ).resolves.toBeNull();
    expect(resolveProviderOAuthCredentialWithPlugin).not.toHaveBeenCalled();
  });

  it("accepts token credentials when config mode is oauth", async () => {
    await expect(
      resolveCredential(
        {
          type: "token",
          provider: "anthropic",
          token: "tok-123",
          expires: Date.now() + 60_000,
        },
        "oauth",
      ),
    ).resolves.toEqual({ apiKey: "tok-123", provider: "anthropic", email: undefined });
  });

  it.each([
    { mode: "api_key" as const, provider: "anthropic" },
    { mode: "token" as const, provider: "openai" },
  ])("rejects incompatible profile configuration: $provider/$mode", async ({ mode, provider }) => {
    await expect(
      resolveCredential(
        {
          type: "token",
          provider: "anthropic",
          token: "tok-123",
        },
        mode,
        provider,
      ),
    ).resolves.toBeNull();
  });

  it("returns null for token credentials with invalid expiry", async () => {
    await expect(
      resolveCredential({
        type: "token",
        provider: "anthropic",
        token: "tok-123",
        expires: Number.NaN,
      }),
    ).resolves.toBeNull();
  });

  it("uses current expired metadata before applying degraded owner state", async () => {
    const profileId = "fixture:default";
    const tokenRef = { source: "env" as const, provider: "default", id: "EXPIRED_TOKEN" };
    const credential = { type: "token" as const, provider: "github-copilot", tokenRef };
    setRuntimeAuthProfileStoreSnapshot(
      createAuthProfileStoreFixture({
        [profileId]: { ...credential, token: "unused", expires: Date.now() + 60_000 },
      }),
    );
    setActiveDegradedSecretOwners([
      {
        ownerKind: "account",
        ownerId: resolveAuthProfileSecretOwnerId({ profileId }),
        state: "unavailable",
        paths: [`auth-profiles.${profileId}.token`],
        refKeys: ["env:default:EXPIRED_TOKEN"],
        reason: "secret reference was not found",
      },
    ]);
    await expect(resolveCredential({ ...credential, expires: Date.now() - 1 })).resolves.toBeNull();
  });

  it("normalizes inline api_key values before header use", async () => {
    await expect(
      resolveCredential({
        type: "api_key",
        provider: "openrouter",
        key: " sk-or-\u202650ec ",
      }),
    ).resolves.toEqual({ apiKey: "sk-or-50ec", provider: "openrouter", email: undefined });
  });

  it("reads published token SecretRefs without an inline source secret", async () => {
    const source = {
      type: "token" as const,
      provider: "github-copilot",
      tokenRef: { source: "env" as const, provider: "default", id: "GITHUB_TOKEN" },
    };
    setRuntimeAuthProfileStoreSnapshot(
      createAuthProfileStoreFixture({
        "fixture:default": { ...source, token: "materialized-secret" },
      }),
    );
    await expect(resolveCredential(source)).resolves.toEqual({
      apiKey: "materialized-secret",
      provider: source.provider,
      email: undefined,
    });
  });

  it("hard-fails when oauth mode is combined with token SecretRef input", async () => {
    await expect(
      resolveCredential(
        {
          type: "token",
          provider: "anthropic",
          tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
        },
        "oauth",
      ),
    ).rejects.toThrow(/mode is "oauth"/i);
  });
});

describe("setup-owned SecretRef materialization", () => {
  beforeEach(() => {
    setRuntimeAuthProfileStoreSnapshot(
      createAuthProfileStoreFixture({
        "openai:unrelated": { type: "api_key", provider: "openai", key: "unchanged-key" },
      }),
    );
  });
  it.each(["abort", "replacement", "nested", "other-store", "other-profile"] as const)(
    "keeps the prepared credential scoped through %s settlement",
    async (settlement) => {
      const { withSetupCredentialAccess, runOutsideSetupCredentialAccess } =
        await import("./setup-access.js");
      const {
        getRuntimeAuthProfileStoreCredentialsRevision,
        getRuntimeAuthProfileStoreSnapshotCore,
      } = await import("./runtime-snapshots.js");
      const profileId = "openai:setup-scope";
      const source = {
        type: "api_key" as const,
        provider: "openai",
        keyRef: { source: "env" as const, provider: "default", id: "SETUP_SCOPED_KEY" },
      };
      const store: AuthProfileStore = { version: 1, profiles: { [profileId]: source } };
      const controller = new AbortController();
      const prior = getRuntimeAuthProfileStoreSnapshotCore();
      const resolve = (agentDir?: string) =>
        resolveApiKeyForProfile({
          cfg: cfgFor(profileId, "openai", "api_key"),
          store,
          profileId,
          agentDir,
        });
      let readAfterClose: (() => ReturnType<typeof resolve>) | undefined;
      await withSetupCredentialAccess(
        {
          profileId,
          signal: controller.signal,
          runtimeCredential: {
            source,
            materialized: { ...source, key: "synthetic-scoped-credential" },
            credentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
          },
        },
        async () => {
          await expect(resolve()).resolves.toMatchObject({ apiKey: "synthetic-scoped-credential" });
          let releaseRetained: (() => void) | undefined;
          const retained = new Promise<void>((done) => {
            releaseRetained = done;
          }).then(() => resolve());
          readAfterClose = () => {
            releaseRetained!();
            return retained;
          };
          if (settlement === "abort") {
            controller.abort();
            await expect(resolve()).rejects.toMatchObject({ code: "SECRET_SURFACE_UNAVAILABLE" });
          } else if (settlement === "replacement") {
            setRuntimeAuthProfileStoreSnapshot({
              version: 1,
              profiles: { [profileId]: { ...source, key: "synthetic-new-owner-credential" } },
            });
            await expect(resolve()).rejects.toMatchObject({ code: "SECRET_SURFACE_UNAVAILABLE" });
          } else if (settlement === "nested") {
            await withSetupCredentialAccess({ profileId }, async () => {
              await expect(resolve()).resolves.toMatchObject({
                apiKey: "synthetic-scoped-credential",
              });
              await runOutsideSetupCredentialAccess(async () => {
                await expect(resolve()).rejects.toMatchObject({
                  code: "SECRET_SURFACE_UNAVAILABLE",
                });
              });
              await expect(resolve()).resolves.toMatchObject({
                apiKey: "synthetic-scoped-credential",
              });
            });
          } else if (settlement === "other-profile") {
            await withSetupCredentialAccess({ profileId: "openai:another-setup" }, async () => {
              await expect(resolve()).rejects.toMatchObject({ code: "SECRET_SURFACE_UNAVAILABLE" });
            });
          } else if (settlement === "other-store") {
            await expect(resolve("/unrelated/setup-owner")).rejects.toMatchObject({
              code: "SECRET_SURFACE_UNAVAILABLE",
            });
          }
        },
      );
      expect(readAfterClose).toBeDefined();
      await expect(readAfterClose!()).rejects.toMatchObject({ code: "SECRET_SURFACE_UNAVAILABLE" });
      if (settlement === "replacement") {
        await expect(resolve()).resolves.toMatchObject({
          apiKey: "synthetic-new-owner-credential",
        });
      } else {
        expect(getRuntimeAuthProfileStoreSnapshotCore()).toEqual(prior);
      }
      expect(store.profiles[profileId]).toEqual(source);
      expect(store.profiles[profileId]).not.toHaveProperty("key");
    },
  );
});
