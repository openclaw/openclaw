import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useSqliteWorkerFault } from "../../../test/helpers/sqlite-worker-fault.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { retainPersistedCredential } from "./credential-authority.test-support.js";
import { clearAuthProfileMigrationDiagnostics } from "./legacy-source-diagnostic.js";
import { withOAuthProfileLock } from "./oauth-profile-lock.js";
import { createOAuthRefreshFence } from "./oauth-refresh-marker.js";
import { loadPersistedAuthProfileStore as readPersistedStore } from "./persisted.js";
import {
  closeAuthProfileReadPool,
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
} from "./sqlite.js";
import { saveAuthProfileStore, updateAuthProfileStoreWithLock } from "./store-runtime.js";
import * as storeRuntime from "./store-runtime.js";
import { withAuthProfileStoreAgentDir } from "./store.js";
import type {
  ApiKeyCredential,
  AuthProfileCredential,
  AuthProfileStore,
  OAuthCredential,
} from "./types.js";
import {
  persistAuthProfileBatch,
  upsertAuthProfileWithLock,
  upsertAuthProfileWithLockOrThrow,
} from "./upsert-with-lock.js";

const authStateFault = useSqliteWorkerFault([
  {
    name: "reject_completed_login_state",
    match: /^(?:insert into|update) auth_profile_state\b/u,
    sql: `CREATE TEMP TRIGGER reject_completed_login_state BEFORE UPDATE ON main.auth_profile_state
      BEGIN SELECT RAISE(ABORT, 'injected completed login state failure'); END;`,
  },
  {
    name: "reject_auth_profile_batch_state",
    match: /^insert into auth_profile_state\b/u,
    sql: `CREATE TEMP TRIGGER reject_auth_profile_batch_state BEFORE INSERT ON main.auth_profile_state
      BEGIN SELECT RAISE(ABORT, 'injected auth batch state failure'); END;`,
  },
]);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  vi.restoreAllMocks();
  for (const stateDir of tempDirs.dirs) {
    closeAuthProfileReadPool({ kind: "root", rootPath: stateDir });
    await cleanupSessionStateForTest({ stateDir });
  }
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  clearAuthProfileMigrationDiagnostics();
});

const apiKey = (key: string): ApiKeyCredential => ({ type: "api_key", provider: "openai", key });
const profile = (profileId: string, key: string) => ({ profileId, credential: apiKey(key) });
const keyStore = (
  keys: Record<string, string>,
  state: Partial<Omit<AuthProfileStore, "version" | "profiles">> = {},
): AuthProfileStore => ({
  version: 1,
  profiles: Object.fromEntries(Object.entries(keys).map(([id, key]) => [id, apiKey(key)])),
  ...state,
});
function oauth(access: string, refresh: string, expires = Date.now() + 60_000): OAuthCredential {
  return { type: "oauth", provider: "openai", access, refresh, expires };
}
function persist(
  agentDir: string | undefined,
  profileId: string,
  credential: AuthProfileCredential,
  options: Omit<Parameters<typeof persistAuthProfileBatch>[0], "agentDir" | "profiles"> = {},
) {
  return persistAuthProfileBatch({ agentDir, profiles: [{ profileId, credential }], ...options });
}
function save(profiles: AuthProfileStore["profiles"], agentDir?: string) {
  saveAuthProfileStore({ version: 1, profiles }, agentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
}
function rotate(agentDir: string, profileId: string, credential: OAuthCredential) {
  return updateAuthProfileStoreWithLock({
    agentDir,
    updater: (store) => {
      store.profiles[profileId] = credential;
      return true;
    },
  });
}
async function withPeers(run: (root: string, main: string, peer: string) => Promise<void>) {
  const root = tempDirs.make("openclaw-auth-peers-");
  const main = path.join(root, "agents", "main", "agent");
  const peer = path.join(root, "agents", "peer", "agent");
  [main, peer].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
  await withEnvAsync({ OPENCLAW_STATE_DIR: root, OPENCLAW_AGENT_DIR: main }, () =>
    run(root, main, peer),
  );
}

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const root = tempDirs.make("openclaw-auth-batch-");
  const agentDir = path.join(root, "agents", "work", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => await run(agentDir));
}

it("persists OAuth login credentials without querying SQLite on the host", async () => {
  await withAgentDir(async (agentDir) => {
    save({}, agentDir);
    const stacks = new Set<string>();
    const sql = observeHostDataSql(() => {
      stacks.add(new Error().stack ?? "");
    });
    try {
      await persist(
        agentDir,
        "fixture:login",
        { ...oauth("fixture", "fixture", 4_000_000_000_000), provider: "fixture" },
        { allowOAuthGenerationReplacement: true },
      );
      expect(sql.queries.length, [...stacks].join("\n")).toBe(0);
    } finally {
      sql.restore();
    }
    expect(readPersistedStore(agentDir)?.profiles["fixture:login"]).toMatchObject({
      type: "oauth",
      provider: "fixture",
      access: "fixture",
      refresh: "fixture",
    });
  });
});

it.each([
  { owner: "local", initial: "missing", root: "selected" },
  { owner: "local", initial: "existing", root: "selected" },
  { owner: "shared", initial: "missing", root: "selected" },
  { owner: "shared", initial: "existing", root: "selected" },
  { owner: "shared", initial: "missing", root: "changed" },
] as const)(
  "refuses a stale OAuth upsert after $owner $initial authority changes during write admission ($root ambient root)",
  async ({ owner, initial, root }) => {
    await withAgentDir(async (agentDir) => {
      const profileId = "openai:admission";
      const incoming = oauth("synthetic-old-access", "synthetic-old-refresh");
      const authoritative = {
        ...incoming,
        access: "synthetic-new-access",
        refresh: "synthetic-new-refresh",
      };
      const ownerDir = owner === "local" ? agentDir : undefined;
      const selectedStateDir = path.resolve(agentDir, "../../..");
      const otherStateDir =
        root === "changed" ? tempDirs.make("auth-upsert-other-root-") : undefined;
      save(initial === "existing" ? { [profileId]: incoming } : {}, ownerDir);
      if (owner === "shared") {
        save({}, agentDir);
      }
      const release = createDeferredCore();
      const entered = createDeferredCore();
      const predecessor = runOpenClawAgentWriteAdmission(
        { agentId: "work", path: resolveAuthProfileDatabasePath(agentDir) },
        async () => {
          await release.promise;
          save({ [profileId]: authoritative }, ownerDir);
          if (otherStateDir) {
            process.env.OPENCLAW_STATE_DIR = otherStateDir;
          }
        },
      );
      const realUpdate = storeRuntime.updateAuthProfileStoreWithLock;
      vi.spyOn(storeRuntime, "updateAuthProfileStoreWithLock").mockImplementation((params) => {
        const updating = realUpdate(params);
        entered.resolve();
        return updating;
      });
      const upsert = upsertAuthProfileWithLock({ agentDir, profileId, credential: incoming });
      void upsert.catch(() => {});
      try {
        await Promise.race([entered.promise, upsert]);
      } finally {
        release.resolve();
        await Promise.allSettled([predecessor, upsert]);
        process.env.OPENCLAW_STATE_DIR = selectedStateDir;
      }
      await predecessor;
      await expect(upsert).resolves.toBeNull();
      expect(readPersistedStore(ownerDir)?.profiles[profileId]).toEqual(authoritative);
      if (owner === "shared") {
        expect(readPersistedStore(agentDir)?.profiles[profileId]).toBeUndefined();
      }
    });
  },
);

it("refuses inherited OAuth authority that changes during the worker callback handoff", async () => {
  await withAgentDir(async (agentDir) => {
    const profileId = "openai:handoff";
    const incoming = oauth("synthetic-old-access", "synthetic-old-refresh");
    const authoritative = {
      ...incoming,
      access: "synthetic-new-access",
      refresh: "synthetic-new-refresh",
    };
    save({});
    save({}, agentDir);
    let callbacks = 0;
    const realUpdate = storeRuntime.updateAuthProfileStoreWithLock;
    vi.spyOn(storeRuntime, "updateAuthProfileStoreWithLock").mockImplementation((params) =>
      realUpdate({
        ...params,
        updater(store, owner, sharedStore) {
          callbacks += 1;
          save({ [profileId]: authoritative });
          return params.updater(store, owner, sharedStore);
        },
      }),
    );

    await expect(
      upsertAuthProfileWithLock({ agentDir, profileId, credential: incoming }),
    ).resolves.toBeNull();
    expect(callbacks).toBe(1);
    expect(readPersistedStore()?.profiles[profileId]).toEqual(authoritative);
    expect(readPersistedStore(agentDir)?.profiles[profileId]).toBeUndefined();
  });
});

it("rejects pre-claim stale writes after the refresh fence settles", async () => {
  await withAgentDir(async (agentDir) => {
    const profileId = "openai:default";
    const credential = oauth("expired-access", "single-use-refresh", Date.now() - 60_000);
    const rotated = oauth("rotated-access", "rotated-refresh");
    const fence = createOAuthRefreshFence({ profileId, credential });
    const siblingId = "openai:sibling";
    const sibling = { ...credential, refresh: "sibling-refresh" };

    saveAuthProfileStore(
      { version: 1, profiles: { [profileId]: credential, [siblingId]: sibling } },
      agentDir,
    );
    let queuedWrite: Promise<void> | undefined;
    await withOAuthProfileLock({ profileId, provider: credential.provider }, async () => {
      queuedWrite = persistAuthProfileBatch({
        agentDir,
        profiles: [
          { profileId, credential },
          { profileId: siblingId, credential: { ...sibling, access: "new-sibling-access" } },
        ],
        resetFailureState: true,
        allowOAuthGenerationReplacement: true,
      }).then(() => undefined);
      await rotate(agentDir, profileId, fence);
      await rotate(agentDir, profileId, rotated);
    });

    expect(queuedWrite).toBeDefined();
    await expect(queuedWrite!).rejects.toThrow(
      "Refused to restore fenced OAuth refresh generation",
    );
    expect(readPersistedStore(agentDir)?.profiles[profileId]).toEqual(rotated);
    expect(readPersistedStore(agentDir)?.profiles[siblingId]).toEqual(sibling);
  });
});

it("rejects stale nonportable OAuth batches admitted after a newer generation settles", async () => {
  await withAgentDir(async (agentDir) => {
    const profileId = "openai:default";
    const consumed = oauth("consumed-access", "consumed-refresh", Date.now() - 60_000);
    const rotated = oauth("rotated-access", "rotated-refresh");
    saveAuthProfileStore({ version: 1, profiles: { [profileId]: rotated } }, agentDir);

    await expect(persist(agentDir, profileId, consumed)).rejects.toThrow(
      "Refused to restore fenced OAuth refresh generation",
    );
    expect(readPersistedStore(agentDir)?.profiles[profileId]).toEqual(rotated);
  });
});

it.each(["rotated", "appeared"] as const)(
  "rejects queued OAuth writes when main authority has %s",
  (mode) =>
    withPeers(async (root, mainAgentDir, peerAgentDir) => {
      const profileId = "openai:default";
      const credential =
        mode === "rotated"
          ? oauth("expired-access", "single-use-refresh", Date.now() - 60_000)
          : oauth("delayed-access", "delayed-refresh");
      const fence = createOAuthRefreshFence({ profileId, credential });
      const authoritative =
        mode === "rotated"
          ? oauth("rotated-access", "rotated-refresh")
          : { ...credential, access: "fresh-login-access", refresh: "fresh-login-refresh" };
      saveAuthProfileStore(
        { version: 1, profiles: mode === "rotated" ? { [profileId]: credential } : {} },
        mainAgentDir,
      );
      let queuedWrite: Promise<void> | undefined;
      await withOAuthProfileLock({ profileId, provider: credential.provider }, async () => {
        queuedWrite = persist(peerAgentDir, profileId, credential, {
          ...(mode === "appeared" ? { stateDir: root } : {}),
          resetFailureState: true,
          allowOAuthGenerationReplacement: true,
        }).then(() => undefined);
        if (mode === "rotated") {
          await rotate(mainAgentDir, profileId, fence);
          await rotate(mainAgentDir, profileId, authoritative);
        } else {
          saveAuthProfileStore(
            { version: 1, profiles: { [profileId]: authoritative } },
            mainAgentDir,
          );
        }
      });

      expect(queuedWrite).toBeDefined();
      await expect(queuedWrite!).rejects.toThrow(
        "Refused to restore fenced OAuth refresh generation",
      );
      expect(readPersistedStore(peerAgentDir)?.profiles[profileId]).toBeUndefined();
      expect(readPersistedStore(mainAgentDir)?.profiles[profileId]).toEqual(authoritative);
    }),
);

it.each(["upsert", "batch"] as const)(
  "compares a scoped %s OAuth refresh against the store it writes",
  async (writer) => {
    const processRoot = tempDirs.make("openclaw-auth-process-root-");
    const scopedRoot = tempDirs.make("openclaw-auth-scoped-root-");
    const agentDir = path.join(scopedRoot, "agents", "work", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const profileId = "openai:default";
    const current = oauth("current-access", "stable-refresh");
    const refreshed = { ...current, access: "refreshed-access", expires: Date.now() + 120_000 };
    const store = { version: 1, profiles: { [profileId]: current } };
    // Upserts follow the scoped agent; batches without agentDir follow the scoped shared store.
    const targetDir = writer === "upsert" ? agentDir : undefined;
    await withEnvAsync({ OPENCLAW_STATE_DIR: scopedRoot }, async () => {
      saveAuthProfileStore(store, targetDir);
    });
    await withEnvAsync({ OPENCLAW_STATE_DIR: processRoot }, async () => {
      await withAuthProfileStoreAgentDir(agentDir, scopedRoot, async () => {
        if (writer === "upsert") {
          await expect(
            upsertAuthProfileWithLock({ profileId, credential: refreshed }),
          ).resolves.not.toBeNull();
        } else {
          await persist(undefined, profileId, refreshed);
        }
      });
    });
    await withEnvAsync({ OPENCLAW_STATE_DIR: scopedRoot }, async () => {
      expect(readPersistedStore(targetDir)?.profiles[profileId]).toEqual(refreshed);
    });
  },
);

it("does not restore a nonportable OAuth generation during batch rollback", async () => {
  await withAgentDir(async (agentDir) => {
    const profileId = "openai:default";
    const previous = oauth("previous-access", "previous-refresh");
    const replacement = {
      ...previous,
      access: "replacement-access",
      refresh: "replacement-refresh",
    };
    saveAuthProfileStore({ version: 1, profiles: { [profileId]: previous } }, agentDir);

    const receipt = await persist(agentDir, profileId, replacement, {
      allowOAuthGenerationReplacement: true,
    });
    expect((await receipt.rollback()).unrevertedProfileIds).toEqual(new Set([profileId]));
    expect((await receipt.rollback()).unrevertedProfileIds).toEqual(new Set([profileId]));

    expect(readPersistedStore(agentDir)?.profiles[profileId]).toEqual(replacement);
  });
});

it("allows portable copies and distinct generations to replace an OAuth fence", async () => {
  await withAgentDir(async (agentDir) => {
    const profileId = "openai:default";
    const credential = oauth("expired-access", "single-use-refresh", Date.now() - 60_000);
    const fence = createOAuthRefreshFence({ profileId, credential });
    saveAuthProfileStore({ version: 1, profiles: { [profileId]: fence } }, agentDir);

    const portable = { ...credential, copyToAgents: true } satisfies OAuthCredential;
    await persist(agentDir, profileId, portable);
    expect(readPersistedStore(agentDir)?.profiles[profileId]).toEqual(portable);

    saveAuthProfileStore({ version: 1, profiles: { [profileId]: fence } }, agentDir);
    const distinct = { ...credential, refresh: "distinct-refresh" } satisfies OAuthCredential;
    await persist(agentDir, profileId, distinct);
    expect(readPersistedStore(agentDir)?.profiles[profileId]).toEqual(distinct);
  });
});

it("conditionally rolls a portable profile batch and its order back to absence", async () => {
  await withAgentDir(async (agentDir) => {
    const noOp = await persistAuthProfileBatch({ agentDir, profiles: [] });
    await noOp.rollback();
    expect(fs.existsSync(resolveAuthProfileDatabasePath(agentDir))).toBe(false);

    const receipt = await persistAuthProfileBatch({
      agentDir,
      profiles: [
        profile("openai:primary", " sk-primary "),
        {
          profileId: "openai:backup",
          credential: { type: "token", provider: "openai", token: " backup-token " },
        },
      ],
      order: { openai: ["openai:primary", "openai:backup"] },
    });

    expect(readPersistedStore(agentDir)).toMatchObject({
      profiles: {
        "openai:primary": { key: "sk-primary" },
        "openai:backup": { token: "backup-token" },
      },
      order: { openai: ["openai:primary", "openai:backup"] },
    });

    await receipt.rollback();
    await receipt.rollback();

    expect(readPersistedStore(agentDir)).toBeNull();
    expect(inspectPersistedAuthProfileStoreRaw(agentDir).status).toBe("missing");
    expect(inspectPersistedAuthProfileStateRaw(agentDir).status).toBe("missing");
  });
});

it("removes only owned profiles and introduced order ids", async () => {
  await withAgentDir(async (agentDir) => {
    saveAuthProfileStore(
      keyStore({ "openai:existing": "sk-existing" }, { order: { openai: ["openai:existing"] } }),
      agentDir,
    );
    const observation = observeHostDataSql();
    const receipt = await persistAuthProfileBatch({
      agentDir,
      profiles: [profile("openai:primary", "sk-attempt"), profile("openai:backup", "sk-backup")],
      order: { openai: ["openai:primary", "openai:backup"] },
    });
    await updateAuthProfileStoreWithLock({
      agentDir,
      saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
      updater: (store) => {
        store.profiles["openai:primary"] = apiKey("sk-newer");
        store.profiles["openai:concurrent"] = apiKey("sk-unrelated");
        store.order = {
          openai: ["openai:primary", "openai:backup", "openai:concurrent", "openai:existing"],
        };
        return true;
      },
    });

    await receipt.rollback();
    observation.restore();
    expect(
      observation.queries.filter((sql) => /\bauth_profile_(?:store|state)\b/iu.test(sql)),
    ).toEqual([]);

    expect(readPersistedStore(agentDir)).toMatchObject({
      profiles: {
        "openai:primary": { key: "sk-newer" },
        "openai:existing": { key: "sk-existing" },
        "openai:concurrent": { key: "sk-unrelated" },
      },
      order: { openai: ["openai:primary", "openai:concurrent", "openai:existing"] },
    });
    expect(readPersistedStore(agentDir)?.profiles["openai:backup"]).toBeUndefined();
  });
});

it("does not claim skipped non-replacing profiles or their order entries", async () => {
  await withAgentDir(async (agentDir) => {
    const original = keyStore(
      { "openai:existing": "sk-existing", "openai:conflict": "sk-concurrent" },
      { order: { openai: ["openai:existing"] } },
    );
    saveAuthProfileStore(original, agentDir);
    const receipt = await persistAuthProfileBatch({
      agentDir,
      profiles: [
        { ...profile("openai:conflict", "sk-portable"), replaceExisting: false },
        { ...profile("openai:portable", "sk-portable"), replaceExisting: false },
      ],
      order: { openai: ["openai:conflict", "openai:portable"] },
    });

    expect(readPersistedStore(agentDir)).toMatchObject({
      profiles: {
        "openai:conflict": { key: "sk-concurrent" },
        "openai:portable": { key: "sk-portable" },
      },
      order: { openai: ["openai:existing", "openai:portable"] },
    });

    await receipt.rollback();

    expect(readPersistedStore(agentDir)).toMatchObject(original);
    expect(readPersistedStore(agentDir)?.profiles["openai:portable"]).toBeUndefined();
  });
});

it.each(["success", "update-failure", "insert-failure"] as const)(
  "persists credentials and failure state atomically ($0)",
  async (outcome) => {
    await withAgentDir(async (agentDir) => {
      const targetId = "openai:target";
      const siblingId = "openai:sibling";
      const history = {
        lastUsed: Date.now() - 10_000,
        lastFailureAt: Date.now() - 5_000,
        lastProbeAt: Date.now() - 2_000,
      };
      const sibling = {
        errorCount: 2,
        blockedUntil: Date.now() + 120_000,
        blockedReason: "subscription_limit" as const,
      };
      const initial = keyStore(
        { [targetId]: "sk-stale", [siblingId]: "sk-sibling" },
        { order: { openai: [siblingId, targetId] }, lastGood: { openai: siblingId } },
      );
      const seeded = {
        ...initial,
        usageStats: {
          [targetId]: {
            errorCount: 4,
            failureCounts: { auth_permanent: 4 },
            blockedUntil: Date.now() + 60_000,
            blockedReason: "subscription_limit",
            blockedSource: "wham",
            blockedModel: "gpt-5.6",
            blockedScope: "model",
            cooldownUntil: Date.now() + 60_000,
            cooldownReason: "auth_permanent",
            cooldownModel: "gpt-5.6",
            disabledUntil: Date.now() + 60_000,
            disabledReason: "auth_permanent",
            ...history,
          },
          [siblingId]: sibling,
        },
      } satisfies AuthProfileStore;
      const original = outcome === "insert-failure" ? null : seeded;
      if (original) {
        saveAuthProfileStore(original, agentDir);
      }
      const authority = original ? retainPersistedCredential(agentDir, targetId) : undefined;
      if (outcome !== "success") {
        authStateFault.enable(outcome === "update-failure" ? 0 : 1);
      }
      try {
        const writing = original
          ? persist(agentDir, targetId, apiKey("sk-fresh"), {
              resetFailureState: true,
              allowOAuthGenerationReplacement: true,
            })
          : persistAuthProfileBatch({
              agentDir,
              profiles: [
                profile("openai:first", "sk-first"),
                profile("openai:second", "sk-second"),
              ],
              order: { openai: ["openai:first", "openai:second"] },
            });
        if (outcome !== "success") {
          const writeKind = outcome === "update-failure" ? "completed login" : "auth batch";
          await expect(writing).rejects.toThrow(`injected ${writeKind} state failure`);
          expect(readPersistedStore(agentDir)).toEqual(original);
        } else {
          await writing;
          expect(authority?.readCurrentCredential()).toEqual(apiKey("sk-fresh"));
          expect(readPersistedStore(agentDir)).toEqual({
            ...initial,
            profiles: { ...initial.profiles, [targetId]: apiKey("sk-fresh") },
            usageStats: { [targetId]: { errorCount: 0, ...history }, [siblingId]: sibling },
          });
        }
      } finally {
        authStateFault.disable();
      }
    });
  },
);

it.each(["migration", "schema"] as const)(
  "reports %s remediation instead of lock-contention retry advice",
  async (fault) => {
    await withAgentDir(async (agentDir) => {
      if (fault === "migration") {
        fs.writeFileSync(
          path.join(agentDir, "auth-profiles.json"),
          JSON.stringify(keyStore({ "openai:legacy": "sk-json-era" })),
        );
      } else {
        await upsertAuthProfileWithLockOrThrow({
          agentDir,
          profileId: "openai:existing",
          credential: apiKey("sk-existing"),
        });
        openOpenClawAgentDatabase({
          agentId: "work",
          path: resolveAuthProfileDatabasePath(agentDir),
        }).db.exec("ALTER TABLE auth_profile_store DROP COLUMN updated_at");
      }
      const failure = await upsertAuthProfileWithLockOrThrow({
        agentDir,
        profileId: "openai:new",
        credential: apiKey("sk-new"),
      }).catch((error: unknown) => error);

      if (fault === "schema") {
        expect(failure).toMatchObject({ name: "SqliteSchemaMismatchError" });
      }
      expect(String(failure)).toContain(
        fault === "schema"
          ? "column definitions differ for auth_profile_store"
          : "requires legacy credential migration",
      );
      expect(String(failure)).toContain("openclaw doctor --fix");
      expect(String(failure)).not.toContain("lock may be busy");
    });
  },
);
