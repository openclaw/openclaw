import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture as makeStore,
} from "./credential-fixtures.test-support.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./path-resolve.native.js";
import {
  mergeLocalAuthProfileStoreWithInheritedStore as inheritStore,
  updateRuntimeAuthProfileStoreInheritedCredentials as updateInherited,
} from "./runtime-snapshot-owner.js";
import {
  clearRuntimeAuthProfileStoreSnapshotCore as clearSnapshot,
  clearRuntimeAuthProfileStoreSnapshots,
  getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  getRuntimeAuthProfileStoreSnapshotCore as readSnapshot,
  getRuntimeAuthProfileStoreSnapshotRevision as revisionOf,
  listRuntimeAuthProfileStoreSnapshotsForSharedOwner as sharedSnapshots,
  noteRuntimeAuthProfileStorePersistedMutation as noteMutation,
  publishRuntimeAuthProfileSharedCredentialMutation,
  registerRuntimeAuthProfileStoreMutationListener,
  setRuntimeAuthProfileStoreSnapshot as publishSnapshot,
  setRuntimeAuthProfileStoreSnapshotAtDatabasePath as publishAtPath,
} from "./runtime-snapshots.js";
import { createSnapshotStore as createStore } from "./runtime-snapshots.test-support.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "./types.js";

function sharedOwner(databasePath: string) {
  return { databasePath, sharedDatabasePath: databasePath, location: "state-db" as const };
}

function publishDerived(
  store: RuntimeAuthProfileStore,
  agentDir: string,
  owner: Parameters<typeof publishAtPath>[3],
) {
  const databasePath = resolveAuthProfileDatabasePath(agentDir);
  publishAtPath(store, databasePath, agentDir, { ...owner, databasePath });
}

afterEach(() => clearRuntimeAuthProfileStoreSnapshots());
beforeEach(() => void prepareSharedAuthStoreOwnershipForNative());

it.each(["api-key", "oauth", "hidden", "unknown"] as const)(
  "invalidates shared shadows according to %s local ownership",
  (kind) => {
    const owner = sharedOwner("/tmp/openclaw-auth-incremental/shared.sqlite");
    const localDir = `/tmp/openclaw-auth-incremental-${kind}`;
    const inheritedDir = "/tmp/openclaw-auth-incremental/inherited";
    const profile = createApiKeyCredential("fixture", "synthetic-local");
    const apiKeyStore = (runtimeLocalProfileIds: string[]) => ({
      ...makeStore({ "fixture:primary": profile }),
      runtimeLocalProfileIds,
      runtimeHasLocalOAuthProfiles: false,
    });
    const store: RuntimeAuthProfileStore =
      kind === "api-key"
        ? apiKeyStore(["fixture:primary"])
        : {
            ...createStore("local"),
            runtimeLocalProfileIds:
              kind === "unknown"
                ? undefined
                : [kind === "hidden" ? "hidden:legacy" : "openai:default"],
          };
    publishDerived(store, localDir, owner);
    if (kind === "api-key") {
      publishDerived(apiKeyStore([]), inheritedDir, owner);
    }
    const mutation = {
      credentialsChanged: true,
      stateChanged: false,
      profileIds: [kind === "api-key" ? "fixture:primary" : "unrelated:changed"],
    };
    const localRevision = revisionOf(localDir);
    if (kind !== "api-key") {
      expect(sharedSnapshots(owner, mutation)).toHaveLength(1);
    }
    noteMutation(undefined, mutation, owner);
    if (kind === "api-key") {
      expect(readSnapshot(localDir)?.profiles["fixture:primary"]).toEqual(profile);
      expect(revisionOf(localDir)).toBe(localRevision);
      expect(readSnapshot(inheritedDir)).toBeUndefined();
      expect(
        sharedSnapshots(owner, {
          ...mutation,
          credentialsChanged: false,
          stateChanged: true,
        }).map((entry) => entry.databasePath),
      ).toEqual([resolveAuthProfileDatabasePath(localDir)]);
    } else {
      expect(readSnapshot(localDir)).toBeUndefined();
    }
  },
);

it("fences a deleted snapshot independently of sibling publication and repeated clear", () => {
  const firstDir = "/tmp/openclaw-auth-deleted-first";
  const secondDir = "/tmp/openclaw-auth-deleted-second";

  publishSnapshot(createStore("first"), firstDir);
  publishSnapshot(createStore("second"), secondDir);
  clearSnapshot(secondDir);
  const deletedRevision = revisionOf(secondDir);
  publishSnapshot(createStore("replaced"), firstDir);
  expect(revisionOf(secondDir)).toBe(deletedRevision);
  clearSnapshot(secondDir);
  expect(revisionOf(secondDir)).toBeGreaterThan(deletedRevision);
});

it("installs shared credential changes without rebuilding unrelated local bodies or selection", () => {
  const local: AuthProfileStore = {
    ...makeStore({ "fixture:local": createApiKeyCredential("fixture", "synthetic-local") }),
    order: { fixture: ["fixture:local"] },
    lastGood: { fixture: "fixture:local" },
    usageStats: { "fixture:local": { lastUsed: 7 } },
  };
  const inherited = createStore("before");
  const prepared = inheritStore(local, inherited);
  const changed = createStore("after");
  const mutation = {
    stateChanged: false,
    profileSetChanged: false,
    profileIds: ["openai:default"],
  };
  const updated = expectDefined(
    updateInherited(prepared, changed, mutation),
    "incremental inherited auth snapshot",
  );
  expect(updated.profiles["openai:default"]).toEqual(changed.profiles["openai:default"]);
  expect(updated.profiles["fixture:local"]).toBe(prepared.profiles["fixture:local"]);
  expect(updated.order).toBe(prepared.order);
  expect(updated.lastGood).toBe(prepared.lastGood);
  expect(updated.usageStats).toBe(prepared.usageStats);
  for (const flag of ["stateChanged", "profileSetChanged"] as const) {
    expect(updateInherited(prepared, changed, { ...mutation, [flag]: true })).toBeUndefined();
  }

  const hiddenLocal = createStore("hidden-local");
  const localOAuth = hiddenLocal.profiles["openai:default"];
  const inheritedOAuth = inherited.profiles["openai:default"];
  if (localOAuth?.type !== "oauth" || inheritedOAuth?.type !== "oauth") {
    throw new Error("Expected OAuth reconciliation fixture");
  }
  localOAuth.expires = 4_000_000_000_000;
  inheritedOAuth.expires = 4_000_000_000_001;
  const reconciled = inheritStore(hiddenLocal, inherited);
  expect(reconciled.runtimeLocalProfileIds).toEqual([]);
  expect(reconciled.runtimeHasLocalOAuthProfiles).toBe(true);
  expect(updateInherited(reconciled, changed, mutation)).toBeUndefined();
});

it("publishes one shared credential generation before notifying any derived snapshot reader", () => {
  const sharedPath = "/tmp/openclaw-auth-atomic/shared.sqlite";
  const owner = { ...sharedOwner(sharedPath), env: {} };
  const agentDirs = ["/tmp/openclaw-auth-atomic/first", "/tmp/openclaw-auth-atomic/second"];
  const fallbackDir = "/tmp/openclaw-auth-atomic/local-oauth";
  const before = createStore("before");
  const after = createStore("after");
  const observations: Array<Array<string | undefined>> = [];
  let unregister: (() => void) | undefined;
  try {
    publishAtPath(before, sharedPath, undefined, owner);
    for (const agentDir of agentDirs) {
      const store = inheritStore(
        makeStore({ local: createApiKeyCredential("fixture", "synthetic-local") }),
        before,
      );
      publishDerived(store, agentDir, owner);
    }
    const fallbackPath = resolveAuthProfileDatabasePath(fallbackDir);
    publishDerived(inheritStore(createStore("local-oauth"), before), fallbackDir, owner);
    unregister = registerRuntimeAuthProfileStoreMutationListener(() => {
      observations.push(
        agentDirs.map((agentDir) => {
          const credential = readSnapshot(agentDir)?.profiles["openai:default"];
          return credential?.type === "oauth" ? credential.access : undefined;
        }),
      );
      expect(readSnapshot(fallbackDir)).toBeUndefined();
    });
    const deferred = publishRuntimeAuthProfileSharedCredentialMutation(owner, after, {
      credentialsChanged: true,
      stateChanged: false,
      profileIds: ["openai:default"],
    });
    expect(deferred?.entries.map((entry) => entry.databasePath)).toEqual([fallbackPath]);
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every((values) => values.every((value) => value === "after"))).toBe(true);
    const shared = getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(sharedPath)?.store;
    const published = { type: "oauth", provider: "openai", access: "after" };
    expect(shared?.profiles["openai:default"]).toMatchObject(published);
    Object.assign(after.profiles["openai:default"]!, { access: "mutated-after-publication" });
    expect(readSnapshot(agentDirs[0])?.profiles["openai:default"]).toMatchObject(published);
  } finally {
    unregister?.();
  }
});
