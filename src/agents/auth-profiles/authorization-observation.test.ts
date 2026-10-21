import { beforeEach, expect, it, vi } from "vitest";
import { defaultPayload } from "../../infra/gateway-state-owner-record.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { captureMcpAuthProfileAuthorization } from "../mcp-auth-profile-authorization.js";
import { enrollAuthProfileAuthorizationInDatabase as enroll } from "./authorization-enrollment.js";
import { readAuthProfileAuthorizationLifetimes as lifetimes } from "./authorization-lifetime.js";
import {
  removeAuthProfilesAcrossOwnerStores,
  upsertAuthProfileWithLockOrThrow as upsert,
} from "./profiles.js";
import {
  inspectPersistedAuthProfileStoreRaw as inspectStore,
  readPersistedAuthProfileStoreRaw as readStore,
  runAuthProfileWriteTransaction as withTransaction,
  writePersistedAuthProfileStoreRaw as writeStore,
} from "./sqlite.js";
import { createAuthOwnerTestFixtures } from "./store-state-owner.test-support.js";

const { seedRoot, apiKey } = createAuthOwnerTestFixtures();
let root: Awaited<ReturnType<typeof seedRoot>>;
beforeEach(async () => {
  root = await seedRoot("before");
  vi.stubEnv("OPENCLAW_STATE_DIR", root.stateDir);
  vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
});
function enrollLocal(agentDir: string, expected?: ReturnType<typeof inspectStore>) {
  return withTransaction(agentDir, (database) =>
    enroll(database.db, "agent", {
      profileId: "local",
      expected: expected ?? inspectStore(agentDir, database),
    }),
  );
}

it("refuses stale worker enrollment without changing a newer credential", async () => {
  const expected = inspectStore(root.agentDir);
  await upsert({ agentDir: root.agentDir, profileId: "local", credential: apiKey("after") });
  const before = readStore(root.agentDir);
  expect(() => enrollLocal(root.agentDir, expected)).toThrow(
    "changed before authorization enrollment",
  );
  expect(readStore(root.agentDir)).toEqual(before);
});

it.each(["commit", "rollback", "unknown", "autocommit"] as const)(
  "settles raw credential writes through their native owner (%s)",
  async (outcome) => {
    // Keep Gateway custody through unknown settlement and database cleanup.
    const ownerLease = acquireGatewayStateOwner({
      databasePath: root.sharedPath,
      payload: { ...defaultPayload(root.sharedPath), role: "gateway" },
    });
    let disposeAuthority: (() => void) | undefined;
    try {
      const authority = await captureMcpAuthProfileAuthorization({
        profileId: "local",
        agentDir: root.agentDir,
        assertCurrent() {},
      });
      disposeAuthority = authority.dispose;
      const before = readStore(root.agentDir);
      const database = withTransaction(root.agentDir, (owner) => owner);
      const payload = { version: 1, profiles: { local: apiKey("replacement") } };
      const failure = new Error("fixture native settlement failed");
      const write = () => writeStore(payload, root.agentDir, database);
      const transaction = () =>
        runSqliteImmediateTransactionSync(
          database.db,
          () => {
            // The supplied handle borrows the outer transaction, even across a savepoint.
            runSqliteImmediateTransactionSync(database.db, write);
            expect(authority.assertCurrent).not.toThrow();
            if (outcome === "rollback") {
              throw failure;
            }
          },
          {
            withCommit(commit) {
              commit();
              if (outcome === "unknown") {
                throw failure;
              }
            },
          },
        );
      if (outcome === "autocommit") {
        write();
      } else if (outcome === "rollback" || outcome === "unknown") {
        expect(transaction).toThrow(failure);
      } else {
        transaction();
      }
      if (outcome === "rollback") {
        expect(readStore(root.agentDir)).toEqual(before);
        expect(authority.assertCurrent).not.toThrow();
        await authority.revalidate();
      } else {
        if (outcome === "unknown") {
          expect(database.db.isOpen).toBe(false);
        }
        const code =
          outcome === "unknown" ? "MCP_AUTHORIZATION_UNAVAILABLE" : "MCP_AUTHORIZATION_RETIRED";
        expect(authority.assertCurrent).toThrow(expect.objectContaining({ code }));
        expect(readStore(root.agentDir)).toMatchObject(payload);
        if (outcome === "unknown") {
          // Committed rows cannot certify a lost settlement acknowledgment.
          await expect(authority.revalidate()).rejects.toMatchObject({ code });
        }
      }
    } finally {
      disposeAuthority?.();
      closeOpenClawAgentDatabasesForTest();
      await closeStateDatabaseForTest();
      ownerLease.release();
    }
  },
);

it("retains enrollment tombstones through canonical removal and ignores replayed metadata", async () => {
  const lifetime = () => lifetimes(readStore(root.agentDir)).local;
  const raw = enrollLocal(root.agentDir).raw;
  const before = lifetime();
  expect(before).toBeTruthy();
  expect(
    await removeAuthProfilesAcrossOwnerStores({
      agentDir: root.agentDir,
      profileIds: ["local"],
    }),
  ).toBe(true);
  const removed = lifetime();
  expect(removed).toBeTruthy();
  expect(removed).not.toBe(before);
  await upsert({
    agentDir: root.agentDir,
    profileId: "local",
    credential: apiKey("before-local"),
  });
  const restored = lifetime();
  expect([before, removed]).not.toContain(restored);
  writeStore(raw, root.agentDir);
  expect(lifetime()).toBe(restored);
});
