import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import * as authProfileClone from "./clone.js";
import { createApiKeyCredential } from "./credential-fixtures.test-support.js";
import {
  getPreparedRuntimeAuthMaterializations,
  recordRuntimeAuthMaterialization,
  registerRuntimeAuthMaterializationMutationListener,
  revokeRuntimeAuthMaterializations,
} from "./runtime-materializations.js";
import {
  createPreparedRuntimeAuthProfileUsageReader,
  getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  restoreOwnedRuntimeAuthProfileStoreSnapshot,
  clearRuntimeAuthProfileStoreSnapshotCore,
  clearRuntimeAuthProfileStoreSnapshots,
  getPreparedRuntimeAuthProfileStoreSnapshotCore,
  getRuntimeAuthProfileStoreSnapshotCore,
  getRuntimeAuthProfileStoreMetadataRevision,
  getRuntimeAuthProfileStoreSnapshotRevision,
  noteRuntimeAuthProfileStorePersistedMutation,
  registerRuntimeAuthProfileStoreMutationListener,
  replaceRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { createSnapshotStore as createStore, testing } from "./runtime-snapshots.test-support.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import type { AuthProfileStore } from "./types.js";

function expectOpenAICodexSnapshotCredential(
  store: AuthProfileStore | undefined,
  params: { access: string; refresh?: string },
) {
  const credential = store?.profiles["openai:default"];
  expect(credential?.type).toBe("oauth");
  if (credential?.type !== "oauth") {
    throw new Error("Expected OpenAI Codex OAuth credential snapshot");
  }
  expect(credential.provider).toBe("openai");
  expect(credential.access).toBe(params.access);
  if (params.refresh) {
    expect(credential.refresh).toBe(params.refresh);
  }
}

describe("runtime auth profile snapshots", () => {
  it("marks default-owner materializations as inherited mutations", () => {
    const listener = vi.fn();
    const unregister = registerRuntimeAuthMaterializationMutationListener(listener);
    try {
      recordRuntimeAuthMaterialization({
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-chatgpt-responses",
        modelBaseUrl: "https://chatgpt.com/backend-api/codex",
        requestTransportOverrides: "none",
        authMode: "oauth",
        runtimeOwnerId: "codex",
      });

      expect(listener).toHaveBeenCalledWith({
        affectsInheritedStores: true,
      });
    } finally {
      unregister();
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it.each(["model"])(
    "publishes %s auth facts without impersonating credential rotation",
    (modelId) => {
      const agentDir = "/tmp/openclaw-auth-runtime-materialized";
      const pluginStoreListener = vi.fn();
      const materializationListener = vi.fn();
      setRuntimeAuthProfileStoreSnapshot(createStore("materialized"), agentDir);
      const unregisterStore = registerRuntimeAuthProfileStoreMutationListener(pluginStoreListener);
      const unregisterMaterialization =
        registerRuntimeAuthMaterializationMutationListener(materializationListener);
      try {
        const materialization = {
          agentDir,
          provider: "openai",
          modelId,
          modelApi: "openai-chatgpt-responses",
          modelBaseUrl: "https://chatgpt.com/backend-api/codex",
          requestTransportOverrides: "none",
          authMode: "oauth",
          runtimeOwnerId: "codex",
          authProfileId: "openai:default",
        } as const;
        expect(recordRuntimeAuthMaterialization(materialization)).toBe(true);
        expect(recordRuntimeAuthMaterialization(materialization)).toBe(false);
        expect(getPreparedRuntimeAuthMaterializations(agentDir)).toEqual([
          {
            provider: "openai",
            modelId,
            modelApi: "openai-chatgpt-responses",
            modelBaseUrl: "https://chatgpt.com/backend-api/codex",
            requestTransportOverrides: "none",
            authMode: "oauth",
            runtimeOwnerId: "codex",
            authProfileId: "openai:default",
          },
        ]);
        const sibling = { ...materialization, modelId: modelId === "Model" ? "model" : "Model" };
        const distinctOwner = { ...materialization, runtimeOwnerId: "other-harness" };
        expect(recordRuntimeAuthMaterialization(sibling)).toBe(true);
        recordRuntimeAuthMaterialization(distinctOwner);
        expect(
          revokeRuntimeAuthMaterializations({
            agentDir,
            provider: "openai",
            runtimeOwnerId: "codex",
          }),
        ).toBe(true);
        expect(
          revokeRuntimeAuthMaterializations({
            agentDir,
            provider: "openai",
            runtimeOwnerId: "codex",
          }),
        ).toBe(false);
        expect(getPreparedRuntimeAuthMaterializations(agentDir)).toEqual([
          expect.objectContaining({ runtimeOwnerId: "other-harness", modelId }),
        ]);
        expect(materializationListener).toHaveBeenCalledTimes(4);
        expect(pluginStoreListener).not.toHaveBeenCalled();

        recordRuntimeAuthMaterialization(materialization);

        setRuntimeAuthProfileStoreSnapshot(createStore("replaced"), agentDir);
        expect(getPreparedRuntimeAuthMaterializations(agentDir)).toEqual([]);
        expect(pluginStoreListener).toHaveBeenCalledOnce();
      } finally {
        unregisterMaterialization();
        unregisterStore();
        clearRuntimeAuthProfileStoreSnapshots();
      }
    },
  );

  it.each(["replace"] as const)(
    "keeps metadata stable while %s publishes bookkeeping for rollback readers",
    () => {
      const agentDir = "/tmp/openclaw-auth-metadata-revision";
      const store = createStore("metadata");
      setRuntimeAuthProfileStoreSnapshot(store, agentDir);
      const metadataRevision = getRuntimeAuthProfileStoreMetadataRevision(agentDir);
      const missingRevision = getRuntimeAuthProfileStoreMetadataRevision("/tmp/absent-auth-owner");
      const snapshotRevision = getRuntimeAuthProfileStoreSnapshotRevision(agentDir);
      const listener = vi.fn();
      const unregister = registerRuntimeAuthProfileStoreMutationListener(listener);
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
      try {
        replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: next }]);
        expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toEqual(next);
        expect(getRuntimeAuthProfileStoreSnapshotRevision(agentDir)).toBeGreaterThan(
          snapshotRevision,
        );
        expect(getRuntimeAuthProfileStoreMetadataRevision(agentDir)).toBe(metadataRevision);
        expect(getRuntimeAuthProfileStoreMetadataRevision("/tmp/absent-auth-owner")).toBe(
          missingRevision,
        );
        expect(listener).not.toHaveBeenCalled();
      } finally {
        unregister();
        clearRuntimeAuthProfileStoreSnapshots();
      }
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
    let cloned: typeof store;
    try {
      cloned = authProfileClone.cloneAuthProfileStore(store);
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
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
    try {
      setRuntimeAuthProfileStoreSnapshot(published, agentDir);
      const read = createPreparedRuntimeAuthProfileUsageReader(agentDir, agentDir);
      setRuntimeAuthProfileStoreSnapshot({ ...published, usageStats: {} }, agentDir);
      const cleared = read(worker);
      expect(cleared.usageStats).toEqual({ "worker:external": { lastUsed: 7 } });
      expect(cleared.profiles).toBe(worker.profiles);
      expect(cleared.order).toBe(worker.order);
      expect(cleared.lastGood).toBe(worker.lastGood);
      expect(worker.usageStats["acme:primary"]).toEqual({ cooldownUntil: 20_000 });

      setRuntimeAuthProfileStoreSnapshot(
        {
          ...published,
          usageStats: {
            "acme:primary": { cooldownUntil: 30_000, failureCounts: { rate_limit: 2 } },
          },
        },
        agentDir,
      );
      const blocked = read(worker);
      expect(blocked.usageStats?.["acme:primary"]).toEqual({
        cooldownUntil: 30_000,
        failureCounts: { rate_limit: 2 },
      });
      expectDefined(blocked.usageStats?.["acme:primary"], "published usage").cooldownUntil = 99;
      expect(read(worker).usageStats?.["acme:primary"]?.cooldownUntil).toBe(30_000);
      expect(cleared.usageStats).toEqual({ "worker:external": { lastUsed: 7 } });
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("keeps usage with the captured physical owner and matching credential", () => {
    const agentDir = "/tmp/openclaw-auth-catalog-owned";
    const siblingDir = "/tmp/openclaw-auth-catalog-sibling";
    const original: AuthProfileStore = {
      version: 1,
      profiles: { "acme:primary": createApiKeyCredential("acme", "owned-not-real") },
      usageStats: { "acme:primary": { cooldownUntil: 20_000 } },
    };
    try {
      setRuntimeAuthProfileStoreSnapshot(original, agentDir);
      setRuntimeAuthProfileStoreSnapshot({ ...original, usageStats: {} }, siblingDir);
      const read = createPreparedRuntimeAuthProfileUsageReader(agentDir, agentDir);
      expect(read(original)).toBe(original);
      setRuntimeAuthProfileStoreSnapshot(
        {
          ...original,
          profiles: { "acme:primary": createApiKeyCredential("acme", "replacement-not-real") },
          usageStats: {},
        },
        agentDir,
      );
      expect(read(original)).toBe(original);
      const current = expectDefined(
        getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(
          resolveAuthProfileDatabasePath(agentDir),
        ),
        "published physical owner",
      );
      restoreOwnedRuntimeAuthProfileStoreSnapshot(
        {
          ...current,
          store: { ...original, usageStats: {} },
          owner: { kind: "unresolved", scope: { stateDir: siblingDir, sharedMainDir: siblingDir } },
        },
        agentDir,
      );
      expect(read(original)).toBe(original);
      clearRuntimeAuthProfileStoreSnapshotCore(agentDir);
      expect(read(original)).toBe(original);
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("refreshes inherited usage without crossing an agent-local profile override", () => {
    const inheritedAuthDir = "/tmp/openclaw-auth-catalog-inherited";
    const agentDir = "/tmp/openclaw-auth-catalog-local";
    const inherited: AuthProfileStore = {
      version: 1,
      profiles: {
        "acme:primary": createApiKeyCredential("acme", "inherited-not-real"),
        "other:primary": createApiKeyCredential("other", "other-not-real"),
      },
      usageStats: { "acme:primary": { cooldownUntil: 20_000 } },
    };
    const local: AuthProfileStore = {
      version: 1,
      profiles: { "acme:primary": createApiKeyCredential("acme", "local-not-real") },
      usageStats: { "acme:primary": { cooldownUntil: 30_000 } },
    };
    try {
      setRuntimeAuthProfileStoreSnapshot(inherited, inheritedAuthDir);
      setRuntimeAuthProfileStoreSnapshot(local, agentDir);
      const worker = expectDefined(
        getPreparedRuntimeAuthProfileStoreSnapshotCore(agentDir, inheritedAuthDir),
        "effective catalog auth",
      );
      const read = createPreparedRuntimeAuthProfileUsageReader(agentDir, inheritedAuthDir);
      setRuntimeAuthProfileStoreSnapshot(
        {
          ...inherited,
          usageStats: { "other:primary": { cooldownUntil: 40_000 } },
        },
        inheritedAuthDir,
      );
      expect(read(worker).usageStats).toEqual({
        "acme:primary": { cooldownUntil: 30_000 },
        "other:primary": { cooldownUntil: 40_000 },
      });
      expect(read(worker).profiles).toBe(worker.profiles);
      setRuntimeAuthProfileStoreSnapshot(inherited, inheritedAuthDir);
      setRuntimeAuthProfileStoreSnapshot({ ...local, usageStats: {} }, agentDir);
      expect(read(worker).usageStats?.["acme:primary"]).toBeUndefined();
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("merges inherited and agent prepared stores without persisted fallback", () => {
    const inheritedAuthDir = "/tmp/openclaw-auth-runtime-inherited";
    const agentDir = "/tmp/openclaw-auth-runtime-agent";
    try {
      setRuntimeAuthProfileStoreSnapshot(
        {
          ...createStore("inherited"),
          profiles: {
            ...createStore("inherited").profiles,
            "anthropic:default": createApiKeyCredential("anthropic", "inherited-key"),
          },
        },
        inheritedAuthDir,
      );
      setRuntimeAuthProfileStoreSnapshot(createStore("agent"), agentDir);

      const prepared = getPreparedRuntimeAuthProfileStoreSnapshotCore(agentDir, inheritedAuthDir);

      expectOpenAICodexSnapshotCredential(prepared, { access: "agent" });
      expect(prepared?.profiles["anthropic:default"]).toMatchObject({
        type: "api_key",
        provider: "anthropic",
        key: "inherited-key",
      });
      expect(
        getPreparedRuntimeAuthProfileStoreSnapshotCore(
          "/tmp/openclaw-auth-runtime-missing",
          "/tmp/openclaw-auth-runtime-also-missing",
        ),
      ).toBeUndefined();
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("does not attribute shared order to an agent without its own snapshot", () => {
    const inheritedAuthDir = "/tmp/openclaw-auth-order-inherited";
    const agentDir = "/tmp/openclaw-auth-order-missing-agent";
    const inherited = {
      ...createStore("inherited-order"),
      runtimeLocalOrderProviderIds: ["openai"],
    };
    try {
      setRuntimeAuthProfileStoreSnapshot(inherited, inheritedAuthDir);
      expect(
        getPreparedRuntimeAuthProfileStoreSnapshotCore(agentDir, inheritedAuthDir),
      ).toMatchObject({
        order: { openai: ["openai:default"] },
        runtimeLocalOrderProviderIds: [],
      });
      expect(getRuntimeAuthProfileStoreSnapshotCore(inheritedAuthDir)).toMatchObject({
        runtimeLocalOrderProviderIds: ["openai"],
      });
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("copies a prepared same-owner snapshot only once and keeps the result isolated", () => {
    const agentDir = "/tmp/openclaw-auth-prepared-same-owner";
    const store = createStore("prepared");
    setRuntimeAuthProfileStoreSnapshot(store, agentDir);
    const clone = vi.spyOn(authProfileClone, "cloneAuthProfileStore");
    try {
      const prepared = expectDefined(
        getPreparedRuntimeAuthProfileStoreSnapshotCore(agentDir, agentDir),
        "prepared same-owner snapshot",
      );
      expect(prepared).toMatchObject(store);
      expect(clone.mock.calls.length).toBeLessThanOrEqual(1);
      expectDefined(prepared.order?.openai, "prepared profile order").push("mutated");
      expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.order?.openai).toEqual([
        "openai:default",
      ]);
    } finally {
      clone.mockRestore();
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("bounds persisted mutation lineage by owner and profile", () => {
    for (let index = 0; index <= testing.MAX_PERSISTED_MUTATION_OWNERS; index += 1) {
      noteRuntimeAuthProfileStorePersistedMutation(`/tmp/openclaw-mutation-owner-${index}`, {
        credentialsChanged: true,
        stateChanged: false,
        profileIds: ["openai:default"],
      });
    }
    for (let index = 0; index <= testing.MAX_PERSISTED_MUTATION_PROFILES_PER_OWNER; index += 1) {
      noteRuntimeAuthProfileStorePersistedMutation("/tmp/openclaw-mutation-profile-owner", {
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
