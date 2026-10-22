import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { openSqliteReadOnlyDatabase } from "../../infra/sqlite-snapshot-source.js";
import * as authProfileClone from "./clone.js";
import { createApiKeyCredential } from "./credential-fixtures.test-support.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./path-resolve.native.js";
import {
  getPreparedRuntimeAuthMaterializations as getMaterializations,
  recordRuntimeAuthMaterialization as recordMaterialization,
  runtimeAuthMaterializationChanges,
  revokeRuntimeAuthMaterializations as revokeMaterializations,
} from "./runtime-materializations.js";
import {
  createPreparedRuntimeAuthProfileUsageReader as createUsageReader,
  getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath as getOwnedSnapshot,
  restoreOwnedRuntimeAuthProfileStoreSnapshot as restoreOwnedSnapshot,
  clearRuntimeAuthProfileStoreSnapshotCore as clearSnapshot,
  clearRuntimeAuthProfileStoreSnapshots as clearSnapshots,
  getPreparedRuntimeAuthProfileStoreSnapshotCore as getPreparedSnapshot,
  getRuntimeAuthProfileStoreSnapshotCore as getSnapshot,
  getRuntimeAuthProfileStoreMetadataRevision as getMetadataRevision,
  getRuntimeAuthProfileStoreSnapshotRevision as getSnapshotRevision,
  noteRuntimeAuthProfileStorePersistedMutation as notePersistedMutation,
  registerRuntimeAuthProfileStoreMutationListener as onStoreMutation,
  replaceRuntimeAuthProfileStoreSnapshots as replaceSnapshots,
  replaceOwnedRuntimeAuthProfileStoreSnapshots as replaceOwnedSnapshots,
  setRuntimeAuthProfileStoreSnapshot as setSnapshot,
} from "./runtime-snapshots.js";
import { createSnapshotStore as createStore, testing } from "./runtime-snapshots.test-support.js";
import { acquireAuthProfileReadDatabase } from "./sqlite-read-pool.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import type { AuthProfileStore } from "./types.js";

const cleanups: Array<() => void> = [];
const publishMaterialization = runtimeAuthMaterializationChanges.onChange;
afterEach(() => {
  runtimeAuthMaterializationChanges.onChange = publishMaterialization;
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  vi.restoreAllMocks();
  clearSnapshots();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const track = (cleanup: () => void) => cleanups.push(cleanup);
function observeMaterializations(
  listener: NonNullable<typeof runtimeAuthMaterializationChanges.onChange>,
) {
  runtimeAuthMaterializationChanges.onChange = (event) => {
    publishMaterialization?.(event);
    listener(event);
  };
}
function apiStore(key: string, cooldownUntil = 20_000): AuthProfileStore {
  return {
    version: 1,
    profiles: { "acme:primary": createApiKeyCredential("acme", key) },
    usageStats: { "acme:primary": { cooldownUntil } },
  };
}
type Usage = AuthProfileStore["usageStats"];
function setUsage(store: AuthProfileStore, dir: string, usageStats: Usage) {
  setSnapshot({ ...store, usageStats }, dir);
}

const materialization = {
  provider: "openai",
  modelId: "model",
  modelApi: "openai-chatgpt-responses",
  modelBaseUrl: "https://chatgpt.com/backend-api/codex",
  requestTransportOverrides: "none",
  authMode: "oauth",
  runtimeOwnerId: "codex",
} as const;

describe("runtime auth profile snapshots", () => {
  beforeEach(() => void prepareSharedAuthStoreOwnershipForNative());

  it("retires only the changed owner's reader until the runtime closes", () => {
    const agentDir = tempDirs.make("auth-snapshot-readers-");
    const databasePath = resolveAuthProfileDatabasePath(agentDir);
    {
      using database = openNodeSqliteDatabase(databasePath);
      database.exec(
        "CREATE TABLE reader_fixture (value TEXT); INSERT INTO reader_fixture VALUES ('available')",
      );
    }
    setSnapshot(createStore("reader-owner"), agentDir);
    const reader = acquireAuthProfileReadDatabase(databasePath, openSqliteReadOnlyDatabase);
    expect(reader.status).toBe("readable");
    if (reader.status !== "readable") {
      throw new Error("Expected a pooled auth reader");
    }
    const revision = getSnapshotRevision(agentDir);
    setUsage(createStore("reader-owner"), agentDir, { "openai:default": { lastUsed: 2 } });
    expect(getSnapshotRevision(agentDir)).not.toBe(revision);
    expect(reader.db.isOpen).toBe(true);
    clearSnapshot(path.join(agentDir, "unrelated"));
    expect(reader.db.isOpen).toBe(true);
    expect(reader.db.prepare("SELECT value FROM reader_fixture").get()).toEqual({
      value: "available",
    });

    clearSnapshot(agentDir);
    expect(reader.db.isOpen).toBe(false);
    const replacement = acquireAuthProfileReadDatabase(databasePath, openSqliteReadOnlyDatabase);
    expect(replacement.status).toBe("readable");
    if (replacement.status !== "readable") {
      throw new Error("Expected the pooled auth reader to reopen");
    }
    clearSnapshots();
    expect(replacement.db.isOpen).toBe(false);
  });

  it("marks default-owner materializations as inherited mutations", () => {
    const listener = vi.fn();
    observeMaterializations(listener);
    recordMaterialization(materialization);
    expect(listener).toHaveBeenCalledWith({ affectsInheritedStores: true });
  });

  it("publishes model auth facts without impersonating credential rotation", () => {
    const agentDir = "/tmp/openclaw-auth-runtime-materialized";
    const pluginStoreListener = vi.fn();
    const materializationListener = vi.fn();
    setSnapshot(createStore("materialized"), agentDir);
    track(onStoreMutation(pluginStoreListener));
    observeMaterializations(materializationListener);
    const facts = { ...materialization, authProfileId: "openai:default" };
    const input = { ...facts, agentDir };
    expect(recordMaterialization(input)).toBe(true);
    expect(recordMaterialization(input)).toBe(false);
    expect(getMaterializations(agentDir)).toEqual([facts]);
    expect(recordMaterialization({ ...input, modelId: "Model" })).toBe(true);
    recordMaterialization({ ...input, runtimeOwnerId: "other-harness" });
    const owner = { agentDir, provider: "openai", runtimeOwnerId: "codex" };
    expect(revokeMaterializations(owner)).toBe(true);
    expect(revokeMaterializations(owner)).toBe(false);
    expect(getMaterializations(agentDir)).toEqual([
      expect.objectContaining({ runtimeOwnerId: "other-harness", modelId: "model" }),
    ]);
    expect(materializationListener).toHaveBeenCalledTimes(4);
    expect(pluginStoreListener).not.toHaveBeenCalled();

    recordMaterialization(input);

    setSnapshot(createStore("replaced"), agentDir);
    expect(getMaterializations(agentDir)).toEqual([]);
    expect(pluginStoreListener).toHaveBeenCalledOnce();
  });

  it("keeps metadata stable while replace publishes bookkeeping for rollback readers", () => {
    const agentDir = "/tmp/openclaw-auth-metadata-revision";
    const store = createStore("metadata");
    setSnapshot(store, agentDir);
    const metadataRevision = getMetadataRevision(agentDir);
    const missingRevision = getMetadataRevision("/tmp/absent-auth-owner");
    const snapshotRevision = getSnapshotRevision(agentDir);
    const listener = vi.fn();
    track(onStoreMutation(listener));
    const next = {
      ...store,
      runtimeInheritsMainState: true,
      lastGood: { openai: "openai:default" },
      usageStats: {
        "openai:default": {
          lastUsed: 2,
          errorCount: 2,
          failureCounts: { timeout: 2 },
          lastFailureAt: 2,
          lastProbeAt: 2,
        },
      },
    };
    replaceSnapshots([{ agentDir, store: next }]);
    expect(getSnapshot(agentDir)).toEqual(next);
    expect(getSnapshotRevision(agentDir)).toBeGreaterThan(snapshotRevision);
    expect(getMetadataRevision(agentDir)).toBe(metadataRevision);
    expect(getMetadataRevision("/tmp/absent-auth-owner")).toBe(missingRevision);
    expect(listener).not.toHaveBeenCalled();
  });

  it.each(["replace", "remove"] as const)(
    "invalidates inherited runtimes after a shared-store %s publishes the complete roster",
    (operation) => {
      const sharedPath = "/tmp/openclaw-auth-publication/state/openclaw.sqlite";
      const agentPath = "/tmp/openclaw-auth-publication/agents/other/agent/openclaw-agent.sqlite";
      const entry = (databasePath: string, key: string) => ({
        databasePath,
        agentDir: path.dirname(databasePath),
        owner: {
          kind: "resolved" as const,
          sharedDatabasePath: sharedPath,
          location: "state-db" as const,
        },
        store: { version: 1, profiles: { "acme:primary": createApiKeyCredential("acme", key) } },
      });
      const shared = entry(sharedPath, "shared-not-real");
      const local = entry(agentPath, "local-not-real");
      replaceOwnedSnapshots([shared, local]);
      const nextLocal = entry(agentPath, "replacement-local-not-real");
      const nextShared =
        operation === "replace" ? entry(sharedPath, "replacement-shared-not-real") : undefined;
      const listener = vi.fn(() => {
        expect(getOwnedSnapshot(agentPath)?.store).toEqual(nextLocal.store);
        expect(getOwnedSnapshot(sharedPath)?.store).toEqual(nextShared?.store);
      });
      track(onStoreMutation(listener));
      replaceOwnedSnapshots(nextShared ? [nextShared, nextLocal] : [nextLocal]);
      expect(listener).toHaveBeenCalledExactlyOnceWith({
        affectsInheritedStores: true,
        profileSetChanged: operation === "remove",
      });
    },
  );

  it("retains the JSON clone contract for nested values without encoding credential bodies", () => {
    const baseStore = createStore("synthetic-access");
    const nested = { value: "original" };
    const array: unknown[] = [undefined];
    array.length = 2;
    array.push(Number.NaN, Infinity, -0, nested);
    const store = {
      ...baseStore,
      metadata: {
        absent: undefined,
        date: new Date("2026-01-01T00:00:00.000Z"),
        array,
        first: nested,
        second: nested,
        projected: { toJSON: (key: string) => ({ key }) },
        boxed: [Object(3), Object("string"), Object(false)],
        ...JSON.parse('{"__proto__":{"synthetic":true}}'),
      },
    };
    const expected = {
      ...baseStore,
      metadata: {
        date: "2026-01-01T00:00:00.000Z",
        array: [null, null, null, null, 0, { value: "original" }],
        first: { value: "original" },
        second: { value: "original" },
        projected: { key: "projected" },
        boxed: [3, "string", false],
        ["__proto__"]: { synthetic: true },
      },
    };
    const stringify = vi.spyOn(JSON, "stringify");
    const cloned = authProfileClone.cloneAuthProfileStore(store);
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
    expect(cloned).toEqual(expected);
    expect(Object.getPrototypeOf(cloned.metadata)).toBe(Object.prototype);
    nested.value = "mutated";
    expect(cloned.metadata.first).toEqual({ value: "original" });
    expect(cloned.metadata.first).not.toBe(cloned.metadata.second);
  });

  it.each([Symbol("non-json")])("rejects non-JSON auth values %s", (value) => {
    expect(() =>
      authProfileClone.cloneAuthProfileStore({ ...createStore("synthetic"), value }),
    ).toThrow(TypeError);
  });

  it("rejects cycles without rejecting repeated JSON containers", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      authProfileClone.cloneAuthProfileStore({ ...createStore("synthetic"), circular }),
    ).toThrow(TypeError);
  });

  it("refreshes only owned usage while keeping frozen worker credentials and references", () => {
    const agentDir = "/tmp/openclaw-auth-catalog-usage";
    const descriptor = {
      type: "token" as const,
      provider: "acme",
      tokenRef: { source: "env" as const, provider: "default", id: "ACME_TOKEN" },
    };
    const published: AuthProfileStore = {
      version: 1,
      profiles: { "acme:primary": descriptor },
      usageStats: { "acme:primary": { cooldownUntil: 20_000 } },
    };
    const worker = Object.freeze({
      ...published,
      profiles: Object.freeze({
        "acme:primary": Object.freeze({ ...descriptor, token: "resolved-not-real" }),
        "worker:external": Object.freeze(createApiKeyCredential("worker", "worker-not-real")),
      }),
      order: Object.freeze({ acme: ["acme:primary"] }),
      lastGood: Object.freeze({ acme: "acme:primary" }),
      usageStats: Object.freeze({
        "acme:primary": Object.freeze({ cooldownUntil: 20_000 }),
        "worker:external": Object.freeze({ lastUsed: 7 }),
      }),
    });
    setSnapshot(published, agentDir);
    const read = createUsageReader(agentDir, agentDir);
    setUsage(published, agentDir, {});
    const cleared = read(worker);
    expect(cleared.usageStats).toEqual({ "worker:external": { lastUsed: 7 } });
    expect(cleared.profiles).toBe(worker.profiles);
    expect(cleared.order).toBe(worker.order);
    expect(cleared.lastGood).toBe(worker.lastGood);
    expect(worker.usageStats["acme:primary"]).toEqual({ cooldownUntil: 20_000 });

    const usage = { cooldownUntil: 30_000, failureCounts: { timeout: 2 } };
    setUsage(published, agentDir, { "acme:primary": usage });
    const blocked = read(worker);
    expect(blocked.usageStats?.["acme:primary"]).toEqual(usage);
    expectDefined(blocked.usageStats?.["acme:primary"], "published usage").cooldownUntil = 99;
    expect(read(worker).usageStats?.["acme:primary"]?.cooldownUntil).toBe(30_000);
    expect(cleared.usageStats).toEqual({ "worker:external": { lastUsed: 7 } });
  });

  it("keeps usage with the captured physical owner and matching credential", () => {
    const agentDir = "/tmp/openclaw-auth-catalog-owned";
    const siblingDir = "/tmp/openclaw-auth-catalog-sibling";
    const original = apiStore("owned-not-real");
    setSnapshot(original, agentDir);
    setUsage(original, siblingDir, {});
    const read = createUsageReader(agentDir, agentDir);
    expect(read(original)).toBe(original);
    setUsage(apiStore("replacement-not-real"), agentDir, {});
    expect(read(original)).toBe(original);
    const current = expectDefined(
      getOwnedSnapshot(resolveAuthProfileDatabasePath(agentDir)),
      "published physical owner",
    );
    restoreOwnedSnapshot(
      {
        ...current,
        store: { ...original, usageStats: {} },
        owner: { kind: "unresolved", scope: { stateDir: siblingDir, sharedMainDir: siblingDir } },
      },
      agentDir,
    );
    expect(read(original)).toBe(original);
    clearSnapshot(agentDir);
    expect(read(original)).toBe(original);
  });

  it("refreshes inherited usage without crossing an agent-local profile override", () => {
    const inheritedAuthDir = "/tmp/openclaw-auth-catalog-inherited";
    const agentDir = "/tmp/openclaw-auth-catalog-local";
    const inherited = {
      ...apiStore("inherited-not-real"),
      profiles: {
        ...apiStore("inherited-not-real").profiles,
        "other:primary": createApiKeyCredential("other", "other-not-real"),
      },
    };
    const local = apiStore("local-not-real", 30_000);
    setSnapshot(inherited, inheritedAuthDir);
    setSnapshot(local, agentDir);
    const worker = expectDefined(
      getPreparedSnapshot(agentDir, inheritedAuthDir),
      "effective catalog auth",
    );
    const read = createUsageReader(agentDir, inheritedAuthDir);
    setUsage(inherited, inheritedAuthDir, { "other:primary": { cooldownUntil: 40_000 } });
    expect(read(worker).usageStats).toEqual({
      "acme:primary": { cooldownUntil: 30_000 },
      "other:primary": { cooldownUntil: 40_000 },
    });
    expect(read(worker).profiles).toBe(worker.profiles);
    setSnapshot(inherited, inheritedAuthDir);
    setUsage(local, agentDir, {});
    expect(read(worker).usageStats?.["acme:primary"]).toBeUndefined();
  });

  it("merges inherited and agent prepared stores without persisted fallback", () => {
    const inheritedAuthDir = "/tmp/openclaw-auth-runtime-inherited";
    const agentDir = "/tmp/openclaw-auth-runtime-agent";
    setSnapshot(
      {
        ...createStore("inherited"),
        profiles: {
          ...createStore("inherited").profiles,
          "anthropic:default": createApiKeyCredential("anthropic", "inherited-key"),
        },
      },
      inheritedAuthDir,
    );
    setSnapshot(createStore("agent"), agentDir);

    const prepared = getPreparedSnapshot(agentDir, inheritedAuthDir);

    expect(prepared?.profiles).toMatchObject({
      "openai:default": { type: "oauth", provider: "openai", access: "agent" },
      "anthropic:default": { type: "api_key", provider: "anthropic", key: "inherited-key" },
    });
    expect(
      getPreparedSnapshot(
        "/tmp/openclaw-auth-runtime-missing",
        "/tmp/openclaw-auth-runtime-also-missing",
      ),
    ).toBeUndefined();
  });

  it("does not attribute shared order to an agent without its own snapshot", () => {
    const inheritedAuthDir = "/tmp/openclaw-auth-order-inherited";
    const agentDir = "/tmp/openclaw-auth-order-missing-agent";
    const inherited = {
      ...createStore("inherited-order"),
      runtimeLocalOrderProviderIds: ["openai"],
    };
    setSnapshot(inherited, inheritedAuthDir);
    expect(getPreparedSnapshot(agentDir, inheritedAuthDir)).toMatchObject({
      order: { openai: ["openai:default"] },
      runtimeLocalOrderProviderIds: [],
    });
    expect(getSnapshot(inheritedAuthDir)).toMatchObject({
      runtimeLocalOrderProviderIds: ["openai"],
    });
  });

  it("copies a prepared same-owner snapshot only once and keeps the result isolated", () => {
    const agentDir = "/tmp/openclaw-auth-prepared-same-owner";
    const store = createStore("prepared");
    setSnapshot(store, agentDir);
    const clone = vi.spyOn(authProfileClone, "cloneAuthProfileStore");
    const prepared = expectDefined(getPreparedSnapshot(agentDir, agentDir), "prepared snapshot");
    expect(prepared).toMatchObject(store);
    expect(clone.mock.calls.length).toBeLessThanOrEqual(1);
    expectDefined(prepared.order?.openai, "prepared profile order").push("mutated");
    expect(getSnapshot(agentDir)?.order?.openai).toEqual(["openai:default"]);
  });

  it("bounds persisted mutation lineage by owner and profile", () => {
    for (let index = 0; index <= testing.MAX_PERSISTED_MUTATION_OWNERS; index += 1) {
      notePersistedMutation(`/tmp/openclaw-mutation-owner-${index}`, {
        credentialsChanged: true,
        stateChanged: false,
        profileIds: ["openai:default"],
      });
    }
    for (let index = 0; index <= testing.MAX_PERSISTED_MUTATION_PROFILES_PER_OWNER; index += 1) {
      notePersistedMutation("/tmp/openclaw-mutation-profile-owner", {
        credentialsChanged: true,
        stateChanged: false,
        profileIds: [`openai:${index}`],
      });
    }

    const counts = testing.getPersistedMutationRecordCounts();
    expect(counts.owners).toBeLessThanOrEqual(testing.MAX_PERSISTED_MUTATION_OWNERS);
    expect(counts.profiles).toBeLessThanOrEqual(testing.MAX_PERSISTED_MUTATION_PROFILES_PER_OWNER);
    testing.resetPersistedMutationLineage();
  });
});
