import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { createApiKeyCredential } from "./credential-fixtures.test-support.js";
import {
  mergeLocalAuthProfileStoreWithInheritedStore,
  updateRuntimeAuthProfileStoreInheritedCredentials,
} from "./runtime-snapshot-owner.js";
import {
  clearRuntimeAuthProfileStoreSnapshotCore,
  clearRuntimeAuthProfileStoreSnapshots,
  getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  getRuntimeAuthProfileStoreSnapshotCore,
  getRuntimeAuthProfileStoreSnapshotRevision,
  listRuntimeAuthProfileStoreSnapshotsForSharedOwner,
  noteRuntimeAuthProfileStorePersistedMutation,
  publishRuntimeAuthProfileSharedCredentialMutation,
  registerRuntimeAuthProfileStoreMutationListener,
  setRuntimeAuthProfileStoreSnapshot,
  setRuntimeAuthProfileStoreSnapshotAtDatabasePath,
} from "./runtime-snapshots.js";
import { createSnapshotStore as createStore } from "./runtime-snapshots.test-support.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "./types.js";

describe("runtime auth snapshot publication", () => {
  it("keeps locally shadowed snapshots unchanged when shared credentials rotate", () => {
    const sharedPath = "/tmp/openclaw-auth-incremental/shared.sqlite";
    const owner = {
      databasePath: sharedPath,
      sharedDatabasePath: sharedPath,
      location: "state-db" as const,
    };
    const localDir = "/tmp/openclaw-auth-incremental/local";
    const inheritedDir = "/tmp/openclaw-auth-incremental/inherited";
    const localPath = resolveAuthProfileDatabasePath(localDir);
    const inheritedPath = resolveAuthProfileDatabasePath(inheritedDir);
    const profile = createApiKeyCredential("fixture", "synthetic-local");
    const mutation = {
      credentialsChanged: true,
      stateChanged: false,
      profileIds: ["fixture:primary"],
    };
    try {
      for (const [databasePath, agentDir, runtimeLocalProfileIds] of [
        [localPath, localDir, ["fixture:primary"]],
        [inheritedPath, inheritedDir, []],
      ] as const) {
        setRuntimeAuthProfileStoreSnapshotAtDatabasePath(
          {
            version: 1,
            profiles: { "fixture:primary": profile },
            runtimeLocalProfileIds: [...runtimeLocalProfileIds],
            runtimeHasLocalOAuthProfiles: false,
          },
          databasePath,
          agentDir,
          { ...owner, databasePath },
        );
      }
      const localRevision = getRuntimeAuthProfileStoreSnapshotRevision(localDir);
      noteRuntimeAuthProfileStorePersistedMutation(undefined, mutation, owner);
      expect(getRuntimeAuthProfileStoreSnapshotCore(localDir)?.profiles["fixture:primary"]).toEqual(
        profile,
      );
      expect(getRuntimeAuthProfileStoreSnapshotRevision(localDir)).toBe(localRevision);
      expect(getRuntimeAuthProfileStoreSnapshotCore(inheritedDir)).toBeUndefined();

      expect(
        listRuntimeAuthProfileStoreSnapshotsForSharedOwner(owner, {
          ...mutation,
          credentialsChanged: false,
          stateChanged: true,
        }).map((entry) => entry.databasePath),
      ).toEqual([localPath]);
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it.each(["oauth", "hidden", "unknown"] as const)(
    "refreshes a shared shadow with %s local ownership facts",
    (kind) => {
      const agentDir = `/tmp/openclaw-auth-incremental-${kind}`;
      const databasePath = resolveAuthProfileDatabasePath(agentDir);
      const sharedDatabasePath = "/tmp/openclaw-auth-incremental/shared.sqlite";
      const owner = {
        databasePath: sharedDatabasePath,
        sharedDatabasePath,
        location: "state-db" as const,
      };
      const store: RuntimeAuthProfileStore = {
        ...createStore("local"),
        runtimeLocalProfileIds:
          kind === "unknown" ? undefined : [kind === "hidden" ? "hidden:legacy" : "openai:default"],
      };
      try {
        setRuntimeAuthProfileStoreSnapshotAtDatabasePath(store, databasePath, agentDir, {
          ...owner,
          databasePath,
        });
        const mutation = {
          credentialsChanged: true,
          stateChanged: false,
          profileIds: ["unrelated:changed"],
        };
        expect(listRuntimeAuthProfileStoreSnapshotsForSharedOwner(owner, mutation)).toHaveLength(1);
        noteRuntimeAuthProfileStorePersistedMutation(undefined, mutation, owner);
        expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
      } finally {
        clearRuntimeAuthProfileStoreSnapshots();
      }
    },
  );

  it("fences a deleted snapshot independently of sibling publication and repeated clear", () => {
    const firstDir = "/tmp/openclaw-auth-deleted-first";
    const secondDir = "/tmp/openclaw-auth-deleted-second";
    try {
      setRuntimeAuthProfileStoreSnapshot(createStore("first"), firstDir);
      setRuntimeAuthProfileStoreSnapshot(createStore("second"), secondDir);
      clearRuntimeAuthProfileStoreSnapshotCore(secondDir);
      const deletedRevision = getRuntimeAuthProfileStoreSnapshotRevision(secondDir);
      setRuntimeAuthProfileStoreSnapshot(createStore("replaced"), firstDir);
      expect(getRuntimeAuthProfileStoreSnapshotRevision(secondDir)).toBe(deletedRevision);
      clearRuntimeAuthProfileStoreSnapshotCore(secondDir);
      expect(getRuntimeAuthProfileStoreSnapshotRevision(secondDir)).toBeGreaterThan(
        deletedRevision,
      );
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("installs shared credential changes without rebuilding unrelated local bodies or selection", () => {
    const local: AuthProfileStore = {
      version: 1,
      profiles: { "fixture:local": createApiKeyCredential("fixture", "synthetic-local") },
      order: { fixture: ["fixture:local"] },
      lastGood: { fixture: "fixture:local" },
      usageStats: { "fixture:local": { lastUsed: 7 } },
    };
    const inherited = createStore("before");
    const prepared = mergeLocalAuthProfileStoreWithInheritedStore(local, inherited);
    const changed = createStore("after");
    const mutation = {
      stateChanged: false,
      profileSetChanged: false,
      profileIds: ["openai:default"],
    };
    const updated = expectDefined(
      updateRuntimeAuthProfileStoreInheritedCredentials(prepared, changed, mutation),
      "incremental inherited auth snapshot",
    );
    expect(updated.profiles["openai:default"]).toEqual(changed.profiles["openai:default"]);
    expect(updated.profiles["fixture:local"]).toBe(prepared.profiles["fixture:local"]);
    expect(updated.order).toBe(prepared.order);
    expect(updated.lastGood).toBe(prepared.lastGood);
    expect(updated.usageStats).toBe(prepared.usageStats);
    expect(
      updateRuntimeAuthProfileStoreInheritedCredentials(prepared, changed, {
        ...mutation,
        stateChanged: true,
      }),
    ).toBeUndefined();
    expect(
      updateRuntimeAuthProfileStoreInheritedCredentials(prepared, changed, {
        ...mutation,
        profileSetChanged: true,
      }),
    ).toBeUndefined();

    const hiddenLocal = createStore("hidden-local");
    const localOAuth = hiddenLocal.profiles["openai:default"];
    const inheritedOAuth = inherited.profiles["openai:default"];
    if (localOAuth?.type !== "oauth" || inheritedOAuth?.type !== "oauth") {
      throw new Error("Expected OAuth reconciliation fixture");
    }
    localOAuth.expires = 4_000_000_000_000;
    inheritedOAuth.expires = 4_000_000_000_001;
    const reconciled = mergeLocalAuthProfileStoreWithInheritedStore(hiddenLocal, inherited);
    expect(reconciled.runtimeLocalProfileIds).toEqual([]);
    expect(reconciled.runtimeHasLocalOAuthProfiles).toBe(true);
    expect(
      updateRuntimeAuthProfileStoreInheritedCredentials(reconciled, changed, mutation),
    ).toBeUndefined();
  });

  it("publishes one shared credential generation before notifying any derived snapshot reader", () => {
    const sharedPath = "/tmp/openclaw-auth-atomic/shared.sqlite";
    const owner = {
      databasePath: sharedPath,
      sharedDatabasePath: sharedPath,
      location: "state-db" as const,
    };
    const agentDirs = ["/tmp/openclaw-auth-atomic/first", "/tmp/openclaw-auth-atomic/second"];
    const fallbackDir = "/tmp/openclaw-auth-atomic/local-oauth";
    const before = createStore("before");
    const after = createStore("after");
    const observations: Array<Array<string | undefined>> = [];
    let unregister: (() => void) | undefined;
    try {
      setRuntimeAuthProfileStoreSnapshotAtDatabasePath(before, sharedPath, undefined, owner);
      for (const agentDir of agentDirs) {
        const databasePath = resolveAuthProfileDatabasePath(agentDir);
        const store = mergeLocalAuthProfileStoreWithInheritedStore(
          {
            version: 1,
            profiles: { local: createApiKeyCredential("fixture", "synthetic-local") },
          },
          before,
        );
        setRuntimeAuthProfileStoreSnapshotAtDatabasePath(store, databasePath, agentDir, {
          ...owner,
          databasePath,
        });
      }
      const fallbackPath = resolveAuthProfileDatabasePath(fallbackDir);
      setRuntimeAuthProfileStoreSnapshotAtDatabasePath(
        mergeLocalAuthProfileStoreWithInheritedStore(createStore("local-oauth"), before),
        fallbackPath,
        fallbackDir,
        { ...owner, databasePath: fallbackPath },
      );
      unregister = registerRuntimeAuthProfileStoreMutationListener(() => {
        observations.push(
          agentDirs.map((agentDir) => {
            const credential =
              getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles["openai:default"];
            return credential?.type === "oauth" ? credential.access : undefined;
          }),
        );
        expect(getRuntimeAuthProfileStoreSnapshotCore(fallbackDir)).toBeUndefined();
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
      expect(shared?.profiles["openai:default"]).toMatchObject({
        type: "oauth",
        provider: "openai",
        access: "after",
      });
      Object.assign(after.profiles["openai:default"]!, { access: "mutated-after-publication" });
      expect(
        getRuntimeAuthProfileStoreSnapshotCore(agentDirs[0])?.profiles["openai:default"],
      ).toMatchObject({
        type: "oauth",
        provider: "openai",
        access: "after",
      });
    } finally {
      unregister?.();
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });
});
