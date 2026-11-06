import { afterEach, beforeAll, expect, it, vi } from "vitest";
import * as providerRuntime from "../plugins/provider-runtime.js";
import { resolveAuthProfileSecretOwnerId } from "../secrets/runtime-auth-profile-owner.js";
import {
  setActiveDegradedSecretOwners,
  type SecretSurfaceUnavailableError,
} from "../secrets/runtime-degraded-state.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./auth-profiles/path-resolve.native.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./auth-profiles/runtime-snapshots.js";
import { resolveApiKeyForProviderCore } from "./model-auth-provider.js";

const tempDirs = createTrackedTempDirs();
beforeAll(() => {
  prepareSharedAuthStoreOwnershipForNative();
});
afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  setActiveDegradedSecretOwners([]);
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

it("does not restore synthetic auth when the preferred credential owner is unavailable", async () => {
  const provider = "custom-auth";
  const profileId = "custom-auth:synthetic";
  const coldProfileId = "custom-auth:cold";
  const agentDir = await tempDirs.make("openclaw-synthetic-fallback-profile-");
  const store = createAuthProfileStoreFixture({
    [profileId]: createApiKeyCredential(provider, "synthetic-defer"),
    [coldProfileId]: {
      type: "api_key" as const,
      provider,
      key: "stale-key-must-not-be-used",
      keyRef: { source: "env" as const, id: "MISSING_CUSTOM_KEY", provider: "default" },
    },
  });
  setRuntimeAuthProfileStoreSnapshot(store, agentDir);
  const ownerId = resolveAuthProfileSecretOwnerId({ agentDir, profileId: coldProfileId });
  setActiveDegradedSecretOwners([
    {
      ownerKind: "account",
      ownerId,
      state: "unavailable",
      paths: [`${agentDir}.auth-profiles.${coldProfileId}.key`],
      refKeys: ["env:default:MISSING_CUSTOM_KEY"],
      reason: "secret reference was not found",
    },
  ]);
  vi.spyOn(providerRuntime, "shouldDeferProviderSyntheticProfileAuthWithPlugin").mockImplementation(
    ({ context }) => context.resolvedApiKey === "synthetic-defer",
  );

  await expect(
    resolveApiKeyForProviderCore({
      provider,
      profileId,
      agentDir,
      cfg: { plugins: { enabled: false }, auth: { order: { [provider]: [coldProfileId] } } },
      store,
    }),
  ).rejects.toMatchObject({
    code: "SECRET_SURFACE_UNAVAILABLE",
    ownerKind: "account",
    ownerId,
  } satisfies Partial<SecretSurfaceUnavailableError>);
});

it("rejects prepared native login as an HTTP credential while preserving availability", async () => {
  const provider = "fixture-native";
  vi.spyOn(providerRuntime, "prepareProviderSyntheticAuthWithPlugin").mockResolvedValue({
    apiKey: "synthetic-native-presence",
    source: "Fixture native login",
    mode: "oauth" as const,
    nativeAuth: { runtime: provider, mode: "oauth" as const },
  });
  const params = {
    provider,
    cfg: { plugins: { enabled: false } },
    store: createAuthProfileStoreFixture({}),
    agentDir: await tempDirs.make("openclaw-native-http-auth-"),
  };
  const { prepareRuntimeAvailableProviderAuth } = await import("./model-auth-runtime.js");
  expect(await prepareRuntimeAvailableProviderAuth(params)).toBe(true);
  await expect(resolveApiKeyForProviderCore(params)).rejects.toMatchObject({
    code: "missing-provider-auth",
    provider,
    message: expect.stringContaining(`Select that runtime or configure an API key`),
  });
});
