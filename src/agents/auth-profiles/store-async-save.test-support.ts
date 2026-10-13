import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isMainThread } from "node:worker_threads";
import type { SessionEntry } from "../../config/sessions/types.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  applyModelOverrideWithAuthProfileCompatibility as applyLegacyModelOverride,
  applyModelOverrideWithAuthProfileCompatibilityAsync as applyModelOverride,
} from "../../plugin-sdk/model-session-runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadPersistedAuthProfileStore, loadPersistedSharedAuthProfileStore } from "./persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import {
  loadAuthProfileStoreWithoutExternalProfilesAsync,
  saveAuthProfileStoreAsync,
} from "./store-runtime.js";
import type { AuthProfileCredential } from "./types.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

assert.equal(isMainThread, true, "Auth saves require the real host writer broker");
const apiKey = (key: string): AuthProfileCredential => ({
  type: "api_key",
  provider: "openai",
  key,
});
const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };

async function withoutHostSql<T>(operation: () => Promise<T>): Promise<T> {
  const native = requireNodeSqlite();
  const restore: Array<() => void> = [];
  const forbid = (prototype: object, method: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
    assert.ok(descriptor, `Missing native SQLite method ${method}`);
    Object.defineProperty(prototype, method, {
      ...descriptor,
      value() {
        throw new Error("Model selection read host SQLite");
      },
    });
    restore.push(() => Object.defineProperty(prototype, method, descriptor));
  };
  for (const method of ["prepare", "exec"]) {
    forbid(native.DatabaseSync.prototype, method);
  }
  for (const method of ["get", "all", "run", "iterate"]) {
    forbid(native.StatementSync.prototype, method);
  }
  try {
    return await operation();
  } finally {
    for (const reset of restore) {
      reset();
    }
  }
}

for (const scope of ["shared", "local"] as const) {
  await withOpenClawTestState(
    { layout: "state-only", label: `auth-save-${scope}` },
    async (state) => {
      const localDir = state.agentDir("local");
      await persistAuthProfileBatch({
        stateDir: state.stateDir,
        profiles: [{ profileId: "shared", credential: apiKey("original") }],
      });
      await persistAuthProfileBatch({
        stateDir: state.stateDir,
        agentDir: localDir,
        profiles: [{ profileId: "local", credential: apiKey("original-local") }],
      });
      const agentDir = scope === "local" ? localDir : undefined;
      const profileId = scope === "local" ? "local" : "shared";
      await saveAuthProfileStoreAsync(
        {
          version: 1,
          profiles: { [profileId]: apiKey("before"), obsolete: apiKey("obsolete") },
          order: { openai: [profileId, "obsolete"] },
          lastGood: { openai: profileId },
          usageStats: { [profileId]: { lastUsed: 42 } },
        },
        agentDir,
        saveOptions,
      );
      assert.deepEqual(
        (await loadAuthProfileStoreWithoutExternalProfilesAsync(agentDir)).usageStats,
        {
          [profileId]: { lastUsed: 42 },
        },
      );

      const replacement = { version: 1, profiles: { [profileId]: apiKey("after") } };
      const saving = saveAuthProfileStoreAsync(replacement, agentDir, saveOptions);
      replacement.profiles[profileId] = apiKey("mutated-after-save");
      await saving;
      const persisted =
        scope === "local"
          ? loadPersistedAuthProfileStore(agentDir)
          : loadPersistedSharedAuthProfileStore(state.env);
      assert.deepEqual(persisted, {
        version: 1,
        profiles: { [profileId]: apiKey("after") },
        order: undefined,
        lastGood: undefined,
        usageStats: undefined,
      });
      const current = await loadAuthProfileStoreWithoutExternalProfilesAsync(agentDir);
      assert.deepEqual(current.profiles[profileId], apiKey("after"));
      assert.equal(current.profiles.obsolete, undefined);
      assert.equal(current.order, undefined);
      assert.equal(current.lastGood, undefined);
      assert.equal(current.usageStats, undefined);
      const local = await loadAuthProfileStoreWithoutExternalProfilesAsync(localDir);
      assert.deepEqual(local.profiles, {
        shared: apiKey(scope === "shared" ? "after" : "original"),
        local: apiKey(scope === "local" ? "after" : "original-local"),
      });
    },
  );
}

await withOpenClawTestState(
  { layout: "state-only", label: "sdk-auth-selection" },
  async (state) => {
    const agentDir = state.agentDir();
    const metadataSnapshot = { plugins: [] };
    const entry: SessionEntry = { sessionId: "sdk-auth-selection", updatedAt: 1 };
    const save = (provider: string) =>
      saveAuthProfileStoreAsync(
        {
          version: 1,
          profiles: { "team:prod": { type: "api_key", provider, key: "synthetic-key" } },
        },
        agentDir,
      );
    await save("fixture-provider");
    const legacyEntry: SessionEntry = { ...entry, authProfileOverride: "team:prod" };
    assert.deepEqual(
      applyLegacyModelOverride({
        cfg: {},
        metadataSnapshot,
        agentDir,
        entry: legacyEntry,
        currentProvider: "fixture-provider",
        selection: { provider: "fixture-provider", model: "selected-model" },
      }),
      { updated: true },
    );
    assert.equal(legacyEntry.authProfileOverride, "team:prod");
    const select = async () => {
      const selected: SessionEntry = { ...entry, authProfileOverride: "team:prod" };
      clearRuntimeAuthProfileStoreSnapshots();
      await withoutHostSql(() =>
        applyModelOverride({
          cfg: {},
          metadataSnapshot,
          agentDir,
          entry: selected,
          currentProvider: "fixture-provider",
          selection: { provider: "fixture-provider", model: "selected-model" },
        }),
      );
      return selected.authProfileOverride;
    };
    assert.equal(await select(), "team:prod");
    await save("fixture-other");
    assert.equal(await select(), undefined);

    for (const provider of ["fixture-provider", "fixture-other"]) {
      const personalId = `personal:${randomUUID()}:${randomUUID()}`;
      const selected: SessionEntry = {
        ...entry,
        authProfileOverride: personalId,
        authProfileOverrideSource: "user-link",
      };
      await applyModelOverride({
        cfg: {},
        metadataSnapshot,
        agentDir,
        entry: selected,
        currentProvider: "fixture-provider",
        selection: { provider, model: "another-model" },
      });
      assert.equal(
        selected.authProfileOverride,
        provider === "fixture-provider" ? personalId : undefined,
      );
      assert.equal(
        selected.authProfileOverrideSource,
        provider === "fixture-provider" ? "user-link" : undefined,
      );
    }
  },
);
