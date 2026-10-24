import { Worker } from "node:worker_threads";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import * as state from "../../state/openclaw-state-db.js";
import * as accountOps from "../../state/user-model-account-operations.js";
import * as accounts from "../../state/user-model-accounts.js";
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
  const { authProfileId: profileId } = accounts.connectUserModelAccount({
    ownerProfileId: owner.id,
    credential,
    assertCurrent() {},
  });
  const reconnect = (replacement = credential, matchesCredential = () => true) =>
    accountOps.connectUserModelAccountAsync({
      ownerProfileId: owner.id,
      credential: replacement,
      matchesCredential,
      assertCurrent() {},
    });
  return { owner, credential, profileId, reconnect };
}

async function capture(profileId: string, assertCurrent = () => {}) {
  const grant = await capturePersonalAuthProfileAuthorization({ profileId, assertCurrent });
  onTestFinished(() => grant.dispose());
  return grant;
}

function withAccount(
  run: (account: ReturnType<typeof fixture> & { env: NodeJS.ProcessEnv }) => Promise<void>,
) {
  return withOpenClawTestState({ scenario: "minimal" }, ({ env }) => run({ ...fixture(), env }));
}

async function withoutMainThreadSql<T>(run: () => T | Promise<T>) {
  const sql = observeMainThreadSql();
  try {
    const result = await run();
    sql.expectIdle();
    return result;
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
  state.runOpenClawStateWriteTransaction(({ db }) => {
    const query = getNodeSqliteKysely<Pick<DB, "secret_store_entries">>(db);
    const scope = {
      scope_kind: "identity",
      scope_id: ownerProfileId,
      name: `model-account:${profileId}`,
    } as const;
    const predicate = query
      .selectFrom("secret_store_entries")
      .select("value")
      .where((eb) => eb.and(scope));
    const row = executeSqliteQuerySync(db, predicate).rows[0]!;
    const value = transform(row.value!);
    const mutation =
      value === undefined
        ? query.deleteFrom("secret_store_entries").where((eb) => eb.and(scope))
        : query
            .updateTable("secret_store_entries")
            .set({ value })
            .where((eb) => eb.and(scope));
    executeSqliteQuerySync(db, mutation);
  });
}

it("keeps its private lifetime through OAuth/usage updates and unlink, with cheap effect assertions", () =>
  withAccount(async ({ owner, profileId }) => {
    const grant = await withoutMainThreadSql(() => capture(profileId));
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
    await accountOps.clearUserProfileAuthLinkAsync({
      profileId: owner.id,
      provider: "synthetic",
      assertCurrent() {},
    });
    await grant.revalidate();
    const next = await capture(profileId);
    expect(next.authorizationId).toBe(grant.authorizationId);
    const requests = vi.spyOn(Worker.prototype, "postMessage");
    await withoutMainThreadSql(() => {
      grant.assertCurrent();
      expect(requests).not.toHaveBeenCalled();
    });
    requests.mockRestore();
    expect(Object.keys(grant).toSorted()).toEqual([
      "assertCurrent",
      "authorizationId",
      "dispose",
      "revalidate",
    ]);
    expect(accounts.readUserModelAuthProfile(profileId)).toEqual({
      credential: expect.objectContaining({ access: "synthetic-refreshed-access" }),
      usageStats: { lastUsed: 17 },
    });
    expect(accounts.listUserModelAccounts({ profileId: owner.id }).accounts[0]).not.toHaveProperty(
      "authorizationId",
    );
    grant.dispose();
    expectRetired(grant);
  }));

it.each(["same bytes", "refreshed bytes"])(
  "survives owner restart but rotates on same-ID reconnect (%s)",
  async (kind) => {
    await withAccount(async ({ profileId, credential, reconnect }) => {
      const before = await capture(profileId);
      const originalId = before.authorizationId;
      await closeOpenClawStateDatabaseAsync();
      const restarted = await capture(profileId);
      expect(restarted.authorizationId).toBe(originalId);
      const connected = await reconnect(
        kind === "same bytes" ? credential : { ...credential, access: "synthetic-new-access" },
      );
      expect(connected.authProfileId).toBe(profileId);
      expectRetired(restarted);
      await expect(restarted.revalidate()).rejects.toMatchObject(retired);
      await closeOpenClawStateDatabaseAsync();
      const replacement = await capture(profileId);
      expect(replacement.authorizationId).not.toBe(originalId);
      replacement.assertCurrent();
    });
  },
);

it("allows concurrent adoption after an out-of-process reconnect without reviving old grants", () =>
  withAccount(async ({ owner, profileId, credential, env }) => {
    const original = await capture(profileId);

    const operationsUrl = new URL("../../state/user-model-account-operations.ts", import.meta.url);
    const databaseUrl = new URL("../../state/openclaw-state-db-cache.ts", import.meta.url);
    const replacement = await runNodeScript(
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { connectUserModelAccountAsync } from ${JSON.stringify(operationsUrl.href)}; ` +
          `import { closeOpenClawStateDatabaseAsync } from ${JSON.stringify(databaseUrl.href)}; ` +
          `const result = await connectUserModelAccountAsync({ ownerProfileId: ${JSON.stringify(owner.id)}, ` +
          `credential: ${JSON.stringify(credential)}, matchesCredential: () => true, assertCurrent() {} });` +
          "console.log(result.authProfileId); await closeOpenClawStateDatabaseAsync();",
      ],
      env,
      30_000,
    );
    expect(replacement.error, replacement.stderr).toBeUndefined();
    expect(replacement.status, replacement.stderr).toBe(0);
    expect(replacement.stdout.trim()).toBe(profileId);
    const adoptedGrants = await Promise.all([capture(profileId), capture(profileId)]);

    for (const adopted of adoptedGrants) {
      expect(adopted.authorizationId).not.toBe(original.authorizationId);
      expect(adopted.authorizationId).toBe(adoptedGrants[0].authorizationId);
      adopted.assertCurrent();
      await adopted.revalidate();
    }
    expectRetired(original);
    await expect(original.revalidate()).rejects.toMatchObject(retired);
  }));

it("separates a different account while preserving the original explicit pin", () =>
  withAccount(async ({ profileId, credential, reconnect }) => {
    const original = await capture(profileId);
    const connected = await reconnect(
      { ...credential, accountId: "synthetic-other-account" },
      () => false,
    );
    expect(connected.authProfileId).not.toBe(profileId);
    const other = await capture(connected.authProfileId);
    expect(other.authorizationId).not.toBe(original.authorizationId);
    await original.revalidate();
    original.assertCurrent();
  }));

it("explicitly enrolls a legacy record once through the native writer without exporting its lifetime", () =>
  withAccount(async ({ profileId }) => {
    mutateRecord(profileId, (raw) => {
      const record = JSON.parse(raw);
      delete record.authorizationId;
      return JSON.stringify(record);
    });
    const grant = await withoutMainThreadSql(() => capture(profileId));
    const { db } = state.openOpenClawStateDatabase();
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
    expect(accounts.readUserModelAuthProfile(profileId)).not.toHaveProperty("authorizationId");
  }));

it("does not enroll missing/deleted accounts or recreate their credentials", () =>
  withAccount(async ({ profileId }) => {
    const grant = await capture(profileId);
    mutateRecord(profileId, () => undefined);
    await expect(grant.revalidate()).rejects.toMatchObject(retired);
    expectRetired(grant);
    await expect(capture(profileId)).rejects.toMatchObject(retired);
    expect(accounts.readUserModelAuthProfile(profileId)).toBeUndefined();
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
  }));
