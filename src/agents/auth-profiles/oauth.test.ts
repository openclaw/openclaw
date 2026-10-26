import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
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

vi.hoisted(() => vi.resetModules());
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
let snapshots: typeof import("./runtime-snapshots.js");
beforeAll(async () => {
  ({ resolveApiKeyForProfile } = await import("./oauth.js"));
  snapshots = await import("./runtime-snapshots.js");
});
beforeEach(() => {
  prepareSharedAuthStoreOwnershipForNative();
  resolveProviderOAuthCredentialWithPlugin.mockClear();
  snapshots.clearRuntimeAuthProfileStoreSnapshots();
  setActiveDegradedSecretOwners([]);
});
afterAll(() => {
  snapshots.clearRuntimeAuthProfileStoreSnapshots();
  setActiveDegradedSecretOwners([]);
  vi.doUnmock("../cli-credentials.js");
  vi.doUnmock("../../plugins/provider-runtime.runtime.js");
  vi.resetModules();
});

function cfgFor(profileId: string, provider: string, mode: "api_key" | "token" | "oauth") {
  return { auth: { profiles: { [profileId]: { provider, mode } } } } satisfies OpenClawConfig;
}
const publishProfiles = (profiles: AuthProfileStore["profiles"]) =>
  snapshots.setRuntimeAuthProfileStoreSnapshot(storeOf(profiles));
const token = (overrides: Partial<Extract<AuthProfileCredential, { type: "token" }>> = {}) =>
  ({ type: "token", provider: "anthropic", token: "tok-123", ...overrides }) as const;
const unavailable = (result: Promise<unknown>) =>
  expect(result).rejects.toMatchObject({ code: "SECRET_SURFACE_UNAVAILABLE" });
const scoped = (result: Promise<unknown>) =>
  expect(result).resolves.toMatchObject({ apiKey: "synthetic-scoped-credential" });
const ref = (id: string) => ({ source: "env", provider: "default", id }) as const;
const refToken = (id: string) =>
  ({ type: "token", provider: "github-copilot", tokenRef: ref(id) }) as const;
const defaultId = "fixture:default";
const resolveCredential = (
  credential: AuthProfileCredential,
  mode = credential.type,
  provider = credential.provider,
) =>
  resolveApiKeyForProfile({
    cfg: cfgFor(defaultId, provider, mode),
    store: storeOf({ [defaultId]: credential }),
    profileId: defaultId,
  });
const resolvedKey = (apiKey: string, provider: string) => ({ apiKey, provider, email: undefined });

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
  ).resolves.toEqual(resolvedKey("tok-123", "anthropic"));
});

it.each([
  ["api_key", "anthropic", token()],
  ["token", "openai", token()],
  ["token", "anthropic", token({ expires: Number.NaN })],
] as const)("rejects unusable token configuration %s/%s", async (mode, provider, credential) => {
  await expect(resolveCredential(credential, mode, provider)).resolves.toBeNull();
});

it("uses current expired metadata before applying degraded owner state", async () => {
  const credential = refToken("EXPIRED_TOKEN");
  publishProfiles({
    [defaultId]: { ...credential, token: "unused", expires: Date.now() + 60_000 },
  });
  setActiveDegradedSecretOwners([
    {
      ownerKind: "account",
      ownerId: resolveAuthProfileSecretOwnerId({ profileId: defaultId }),
      state: "unavailable",
      paths: [`auth-profiles.${defaultId}.token`],
      refKeys: ["env:default:EXPIRED_TOKEN"],
      reason: "secret reference was not found",
    },
  ]);
  await expect(resolveCredential({ ...credential, expires: Date.now() - 1 })).resolves.toBeNull();
});

it("normalizes inline api_key values before header use", async () => {
  await expect(
    resolveCredential(createApiKeyCredential("openrouter", " sk-or-\u202650ec ")),
  ).resolves.toEqual(resolvedKey("sk-or-50ec", "openrouter"));
});

it("reads published token SecretRefs without an inline source secret", async () => {
  const source = refToken("GITHUB_TOKEN");
  publishProfiles({ "fixture:default": { ...source, token: "materialized-secret" } });
  await expect(resolveCredential(source)).resolves.toEqual(
    resolvedKey("materialized-secret", source.provider),
  );
});

it("hard-fails when oauth mode is combined with token SecretRef input", async () => {
  await expect(
    resolveCredential({ ...refToken("ANTHROPIC_TOKEN"), provider: "anthropic" }, "oauth"),
  ).rejects.toThrow(/mode is "oauth"/i);
});
it.each(["abort", "replacement", "nested", "other-store", "other-profile"] as const)(
  "keeps the prepared credential scoped through %s settlement",
  async (settlement) => {
    publishProfiles({ "openai:unrelated": createApiKeyCredential("openai", "unchanged-key") });
    const { withSetupCredentialAccess: withSetup, runOutsideSetupCredentialAccess: outsideSetup } =
      await import("./setup-access.js");
    const {
      getRuntimeAuthProfileStoreCredentialsRevision: getRevision,
      getRuntimeAuthProfileStoreSnapshotCore: getSnapshot,
    } = snapshots;
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
    const release = createDeferredCore();
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
    release.resolve();
    await unavailable(retained!);
    if (settlement === "replacement") {
      await expect(resolve()).resolves.toMatchObject({
        apiKey: "synthetic-new-owner-credential",
      });
    } else {
      expect(getSnapshot()).toEqual(prior);
    }
    expect(store.profiles[profileId]).toEqual(source);
    expect(store.profiles[profileId]).not.toHaveProperty("key");
  },
);
