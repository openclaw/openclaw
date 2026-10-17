import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  connectUserModelAccountAsync,
  clearUserProfileAuthLinkAsync,
} from "../../state/user-model-account-operations.js";
import {
  connectUserModelAccount,
  listUserModelAccounts,
  readUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { mergeCanonicalUserProfiles } from "../../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { capturePersonalAuthProfileAuthorization } from "./personal-authorization.js";
import { withPersonalAuthProfileStore } from "./personal-store.js";
import { authProfileRuntimeMode } from "./runtime-scope.js";
import type { OAuthCredential } from "./types.js";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const owner = ensureProfileForEmail("personal-authorization@example.test");
  const credential: OAuthCredential = {
    type: "oauth",
    provider: "synthetic",
    access: "synthetic-access",
    refresh: "synthetic-refresh",
    expires: 1,
    accountId: "synthetic-account",
  };
  const { authProfileId: profileId } = connectUserModelAccount({
    ownerProfileId: owner.id,
    credential,
    assertCurrent() {},
  });
  return { owner, credential, profileId };
}

function capture(profileId: string, assertCurrent = () => {}) {
  return capturePersonalAuthProfileAuthorization({ profileId, assertCurrent });
}

function withAccount(
  run: (account: ReturnType<typeof fixture> & { env: NodeJS.ProcessEnv }) => Promise<void>,
) {
  return withOpenClawTestState({ scenario: "minimal" }, ({ env }) => run({ ...fixture(), env }));
}

async function captureWithoutMainThreadSql(profileId: string) {
  const sql = observeMainThreadSql();
  try {
    const grant = await capture(profileId);
    sql.expectIdle();
    return grant;
  } finally {
    sql.restore();
  }
}

const retired = { code: "MCP_AUTHORIZATION_RETIRED" };
function expectRetired(grant: Awaited<ReturnType<typeof capture>>) {
  expect(grant.assertCurrent).toThrow(expect.objectContaining(retired));
}

function mutateRecord(profileId: string, transform: (value: string) => string | undefined) {
  const ownerProfileId = profileId.split(":")[1]!;
  runOpenClawStateWriteTransaction(({ db }) => {
    const query = getNodeSqliteKysely<Pick<DB, "secret_store_entries">>(db);
    const predicate = query
      .selectFrom("secret_store_entries")
      .select("value")
      .where("scope_kind", "=", "identity")
      .where("scope_id", "=", ownerProfileId)
      .where("name", "=", `model-account:${profileId}`);
    const row = executeSqliteQuerySync(db, predicate).rows[0]!;
    const value = transform(row.value!);
    if (value === undefined) {
      executeSqliteQuerySync(
        db,
        query
          .deleteFrom("secret_store_entries")
          .where("scope_kind", "=", "identity")
          .where("scope_id", "=", ownerProfileId)
          .where("name", "=", `model-account:${profileId}`),
      );
    } else {
      executeSqliteQuerySync(
        db,
        query
          .updateTable("secret_store_entries")
          .set({ value })
          .where("scope_kind", "=", "identity")
          .where("scope_id", "=", ownerProfileId)
          .where("name", "=", `model-account:${profileId}`),
      );
    }
  });
}

it("keeps its private lifetime through OAuth/usage updates and unlink, with cheap effect assertions", () =>
  withAccount(async ({ owner, profileId }) => {
    const grant = await captureWithoutMainThreadSql(profileId);
    await withPersonalAuthProfileStore(profileId, async (store) => {
      await store.update(
        (current) => {
          const credential = current.profiles[profileId];
          if (credential?.type !== "oauth") {
            throw new Error("Expected synthetic OAuth credential");
          }
          current.profiles[profileId] = {
            ...credential,
            access: "synthetic-refreshed-access",
            refresh: "synthetic-refreshed-refresh",
            expires: 2,
          };
          current.usageStats = { [profileId]: { lastUsed: 17 } };
          return true;
        },
        () => {
          expect(grant.assertCurrent).toThrow(
            expect.objectContaining({ code: "MCP_AUTHORIZATION_UNAVAILABLE" }),
          );
        },
      );
    });
    await clearUserProfileAuthLinkAsync({
      profileId: owner.id,
      provider: "synthetic",
      assertCurrent() {},
    });
    await grant.revalidate();
    const next = await capture(profileId);
    expect(next.authorizationId).toBe(grant.authorizationId);
    const requests = vi.spyOn(Worker.prototype, "postMessage");
    const effectSql = observeMainThreadSql();
    try {
      grant.assertCurrent();
      effectSql.expectIdle();
      expect(requests).not.toHaveBeenCalled();
    } finally {
      effectSql.restore();
      requests.mockRestore();
    }
    expect(Object.keys(grant).toSorted()).toEqual([
      "assertCurrent",
      "authorizationId",
      "dispose",
      "revalidate",
    ]);
    expect(readUserModelAuthProfile(profileId)).toEqual({
      credential: expect.objectContaining({ access: "synthetic-refreshed-access" }),
      usageStats: { lastUsed: 17 },
    });
    expect(listUserModelAccounts({ profileId: owner.id }).accounts[0]).not.toHaveProperty(
      "authorizationId",
    );
    grant.dispose();
    next.dispose();
    expectRetired(grant);
  }));

it.each(["same bytes", "refreshed bytes"])(
  "survives owner restart but rotates on same-ID reconnect (%s)",
  async (kind) => {
    await withAccount(async ({ owner, profileId, credential }) => {
      const before = await capture(profileId);
      const originalId = before.authorizationId;
      await closeOpenClawStateDatabaseAsync();
      const restarted = await capture(profileId);
      expect(restarted.authorizationId).toBe(originalId);
      const connected = await connectUserModelAccountAsync({
        ownerProfileId: owner.id,
        credential:
          kind === "same bytes" ? credential : { ...credential, access: "synthetic-new-access" },
        matchesCredential: () => true,
        assertCurrent() {},
      });
      expect(connected.authProfileId).toBe(profileId);
      expectRetired(restarted);
      await expect(restarted.revalidate()).rejects.toMatchObject(retired);
      await closeOpenClawStateDatabaseAsync();
      const replacement = await capture(profileId);
      expect(replacement.authorizationId).not.toBe(originalId);
      replacement.assertCurrent();
      before.dispose();
      restarted.dispose();
      replacement.dispose();
    });
  },
);

it("allows concurrent adoption after an out-of-process reconnect without reviving old grants", () =>
  withAccount(async ({ owner, profileId, credential, env }) => {
    const original = await capture(profileId);
    try {
      const operationsUrl = new URL(
        "../../state/user-model-account-operations.ts",
        import.meta.url,
      );
      const databaseUrl = new URL("../../state/openclaw-state-db-cache.ts", import.meta.url);
      const replacement = await runNodeScript(
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          "import { connectUserModelAccountAsync } from " +
            JSON.stringify(operationsUrl.href) +
            "; import { closeOpenClawStateDatabaseAsync } from " +
            JSON.stringify(databaseUrl.href) +
            "; const result = await connectUserModelAccountAsync({ ownerProfileId: " +
            JSON.stringify(owner.id) +
            ", credential: " +
            JSON.stringify(credential) +
            ", matchesCredential: () => true, assertCurrent() {} });" +
            "console.log(result.authProfileId); await closeOpenClawStateDatabaseAsync();",
        ],
        env,
        30_000,
      );
      expect(replacement.error, replacement.stderr).toBeUndefined();
      expect(replacement.status, replacement.stderr).toBe(0);
      expect(replacement.stdout.trim()).toBe(profileId);
      const adoptedGrants = await Promise.all([capture(profileId), capture(profileId)]);
      try {
        for (const adopted of adoptedGrants) {
          expect(adopted.authorizationId).not.toBe(original.authorizationId);
          expect(adopted.authorizationId).toBe(adoptedGrants[0].authorizationId);
          adopted.assertCurrent();
          await adopted.revalidate();
        }
        expectRetired(original);
        await expect(original.revalidate()).rejects.toMatchObject(retired);
      } finally {
        for (const adopted of adoptedGrants) {
          adopted.dispose();
        }
      }
    } finally {
      original.dispose();
    }
  }));

it("separates a different account while preserving the original explicit pin", () =>
  withAccount(async ({ owner, profileId, credential }) => {
    const original = await capture(profileId);
    const connected = await connectUserModelAccountAsync({
      ownerProfileId: owner.id,
      credential: { ...credential, accountId: "synthetic-other-account" },
      matchesCredential: () => false,
      assertCurrent() {},
    });
    expect(connected.authProfileId).not.toBe(profileId);
    const other = await capture(connected.authProfileId);
    expect(other.authorizationId).not.toBe(original.authorizationId);
    await original.revalidate();
    original.assertCurrent();
    original.dispose();
    other.dispose();
  }));

it("explicitly enrolls a legacy record once through the native writer without exporting its lifetime", () =>
  withAccount(async ({ profileId }) => {
    mutateRecord(profileId, (raw) => {
      const record = JSON.parse(raw);
      delete record.authorizationId;
      return JSON.stringify(record);
    });
    const grant = await captureWithoutMainThreadSql(profileId);
    const { db } = openOpenClawStateDatabase();
    const row = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<Pick<DB, "secret_store_entries">>(db)
        .selectFrom("secret_store_entries")
        .select("value")
        .where("name", "=", `model-account:${profileId}`),
    ).rows[0]!;
    expect(JSON.parse(row.value!).authorizationId).toMatch(/^[0-9a-f-]{36}$/);
    await closeOpenClawStateDatabaseAsync();
    const restarted = await capture(profileId);
    expect(restarted.authorizationId).toBe(grant.authorizationId);
    expect(readUserModelAuthProfile(profileId)).not.toHaveProperty("authorizationId");
    grant.dispose();
    restarted.dispose();
  }));

it("does not enroll missing/deleted accounts or recreate their credentials", () =>
  withAccount(async ({ profileId }) => {
    const grant = await capture(profileId);
    mutateRecord(profileId, () => undefined);
    await expect(grant.revalidate()).rejects.toMatchObject(retired);
    expectRetired(grant);
    await expect(capture(profileId)).rejects.toMatchObject(retired);
    expect(readUserModelAuthProfile(profileId)).toBeUndefined();
    grant.dispose();
  }));

it("retires transferred ownership and preserves a distinct lifetime after restart", () =>
  withAccount(async ({ owner, profileId }) => {
    const target = ensureProfileForEmail("personal-authorization-target@example.test");
    const grant = await capture(profileId);
    await mergeCanonicalUserProfiles(owner.id, target.id);
    expectRetired(grant);
    await closeOpenClawStateDatabaseAsync();
    const transferred = await capture(profileId);
    expect(transferred.authorizationId).not.toBe(grant.authorizationId);
    transferred.assertCurrent();
    grant.dispose();
    transferred.dispose();
  }));

it("retains caller revocation and refuses isolated auth scopes", () =>
  withAccount(async ({ profileId }) => {
    let current = true;
    const grant = await capture(profileId, () => {
      if (!current) {
        throw new Error("Synthetic caller closed");
      }
    });
    current = false;
    expectRetired(grant);
    current = true;
    await expect(grant.revalidate()).rejects.toMatchObject(retired);
    await expect(
      authProfileRuntimeMode.run({ kind: "env-only" }, () => capture(profileId)),
    ).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_UNAVAILABLE" });
    grant.dispose();
  }));
