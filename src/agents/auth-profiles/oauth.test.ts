import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAuthProfileSecretOwnerId } from "../../secrets/runtime-auth-profile-owner.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createAuthProfileStoreFixture as storeOf,
  createApiKeyCredential,
  createOAuthRefreshCredential,
} from "./credential-fixtures.test-support.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./path-resolve.native.js";
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
  prepareSharedAuthStoreOwnershipForNative();
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
const publishProfiles = (profiles: AuthProfileStore["profiles"]) =>
  setRuntimeAuthProfileStoreSnapshot(storeOf(profiles));
const token = (overrides: Partial<Extract<AuthProfileCredential, { type: "token" }>> = {}) =>
  ({ type: "token", provider: "anthropic", token: "tok-123", ...overrides }) as const;
const unavailable = (result: Promise<unknown>) =>
  expect(result).rejects.toMatchObject({ code: "SECRET_SURFACE_UNAVAILABLE" });
const scoped = (result: Promise<unknown>) =>
  expect(result).resolves.toMatchObject({ apiKey: "synthetic-scoped-credential" });
const ref = (id: string) => ({ source: "env", provider: "default", id }) as const;
const refToken = (id: string) =>
  ({ type: "token", provider: "github-copilot", tokenRef: ref(id) }) as const;
function resolveCredential(
  credential: AuthProfileCredential,
  mode = credential.type,
  provider = credential.provider,
) {
  const profileId = "fixture:default";
  return resolveApiKeyForProfile({
    cfg: cfgFor(profileId, provider, mode),
    store: storeOf({ [profileId]: credential }),
    profileId,
  });
}

describe("resolveApiKeyForProfile", () => {
  it("rejects a persisted Claude CLI token", async () => {
    const profileId = "anthropic:claude-cli";
    const store: RuntimeAuthProfileStore = {
      ...storeOf({ [profileId]: createOAuthRefreshCredential({ provider: "anthropic" }) }),
      runtimePersistedProfileIds: [profileId],
    };
    await expect(
      resolveApiKeyForProfile({ cfg: cfgFor(profileId, "anthropic", "oauth"), store, profileId }),
    ).resolves.toBeNull();
    expect(resolveProviderOAuthCredentialWithPlugin).not.toHaveBeenCalled();
  });

  it("accepts token credentials when config mode is oauth", async () => {
    await expect(
      resolveCredential(token({ expires: Date.now() + 60_000 }), "oauth"),
    ).resolves.toEqual({ apiKey: "tok-123", provider: "anthropic", email: undefined });
  });

  it.each([
    { mode: "api_key" as const, provider: "anthropic" },
    { mode: "token" as const, provider: "openai" },
  ])("rejects incompatible profile configuration: $provider/$mode", async ({ mode, provider }) => {
    await expect(resolveCredential(token(), mode, provider)).resolves.toBeNull();
  });

  it("returns null for token credentials with invalid expiry", async () => {
    await expect(resolveCredential(token({ expires: Number.NaN }))).resolves.toBeNull();
  });

  it("uses current expired metadata before applying degraded owner state", async () => {
    const profileId = "fixture:default";
    const credential = refToken("EXPIRED_TOKEN");
    publishProfiles({
      [profileId]: { ...credential, token: "unused", expires: Date.now() + 60_000 },
    });
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
      resolveCredential(createApiKeyCredential("openrouter", " sk-or-\u202650ec ")),
    ).resolves.toEqual({ apiKey: "sk-or-50ec", provider: "openrouter", email: undefined });
  });

  it("reads published token SecretRefs without an inline source secret", async () => {
    const source = refToken("GITHUB_TOKEN");
    publishProfiles({ "fixture:default": { ...source, token: "materialized-secret" } });
    await expect(resolveCredential(source)).resolves.toEqual({
      apiKey: "materialized-secret",
      provider: source.provider,
      email: undefined,
    });
  });

  it("hard-fails when oauth mode is combined with token SecretRef input", async () => {
    await expect(
      resolveCredential({ ...refToken("ANTHROPIC_TOKEN"), provider: "anthropic" }, "oauth"),
    ).rejects.toThrow(/mode is "oauth"/i);
  });
});

describe("setup-owned SecretRef materialization", () => {
  beforeEach(() => {
    publishProfiles({ "openai:unrelated": createApiKeyCredential("openai", "unchanged-key") });
  });
  it.each(["abort", "replacement", "nested", "other-store", "other-profile"] as const)(
    "keeps the prepared credential scoped through %s settlement",
    async (settlement) => {
      const {
        withSetupCredentialAccess: withSetup,
        runOutsideSetupCredentialAccess: outsideSetup,
      } = await import("./setup-access.js");
      const {
        getRuntimeAuthProfileStoreCredentialsRevision: getRevision,
        getRuntimeAuthProfileStoreSnapshotCore: getSnapshot,
      } = await import("./runtime-snapshots.js");
      const profileId = "openai:setup-scope";
      const source = {
        type: "api_key" as const,
        provider: "openai",
        keyRef: ref("SETUP_SCOPED_KEY"),
      };
      const store: AuthProfileStore = storeOf({ [profileId]: source });
      const controller = new AbortController();
      const prior = getSnapshot();
      const resolve = (agentDir?: string) =>
        resolveApiKeyForProfile({
          cfg: cfgFor(profileId, "openai", "api_key"),
          store,
          profileId,
          agentDir,
        });
      const release = createDeferredCore<void>();
      let retained: ReturnType<typeof resolve> | undefined;
      await withSetup(
        {
          profileId,
          signal: controller.signal,
          runtimeCredential: {
            source,
            materialized: { ...source, key: "synthetic-scoped-credential" },
            credentialsRevision: getRevision(),
          },
        },
        async () => {
          await scoped(resolve());
          retained = release.promise.then(() => resolve());
          if (settlement === "abort") {
            controller.abort();
            await unavailable(resolve());
          } else if (settlement === "replacement") {
            publishProfiles({ [profileId]: { ...source, key: "synthetic-new-owner-credential" } });
            await unavailable(resolve());
          } else if (settlement === "nested") {
            await withSetup({ profileId }, async () => {
              await scoped(resolve());
              await outsideSetup(async () => {
                await unavailable(resolve());
              });
              await scoped(resolve());
            });
          } else if (settlement === "other-profile") {
            await withSetup({ profileId: "openai:another-setup" }, async () => {
              await unavailable(resolve());
            });
          } else if (settlement === "other-store") {
            await unavailable(resolve("/unrelated/setup-owner"));
          }
        },
      );
      expect(retained).toBeDefined();
      release.resolve();
      await unavailable(retained!);
      if (settlement === "replacement") {
        await expect(resolve()).resolves.toMatchObject({
          apiKey: "synthetic-new-owner-credential",
        });
      } else {
        expect(getSnapshot()).toEqual(prior);
      }
      expect(store.profiles[profileId]).toStrictEqual(source);
    },
  );
});
