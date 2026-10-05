import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { enrollAuthProfileAuthorizationInDatabase } from "./authorization-enrollment.js";
import { readAuthProfileAuthorizationLifetimes } from "./authorization-lifetime.js";
import {
  fenceAuthProfileAuthorizationWrite,
  retainAuthProfileAuthorizationObservation,
} from "./authorization-observation.js";
import {
  removeAuthProfilesAcrossOwnerStores,
  upsertAuthProfileWithLockOrThrow,
} from "./profiles.js";
import {
  inspectPersistedAuthProfileStoreRaw,
  readPersistedAuthProfileStoreRaw,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStoreRaw,
} from "./sqlite.js";
import { createAuthOwnerTestFixtures } from "./store-state-owner.test-support.js";

const { seedRoot, apiKey } = createAuthOwnerTestFixtures();

describe("auth-profile writer publication", () => {
  it("refuses stale worker enrollment without changing a newer credential", async () => {
    const root = await seedRoot("before");
    await withEnvAsync(root.env, async () => {
      const expected = inspectPersistedAuthProfileStoreRaw(root.agentDir);
      await upsertAuthProfileWithLockOrThrow({
        agentDir: root.agentDir,
        profileId: "local",
        credential: apiKey("after"),
      });
      const before = readPersistedAuthProfileStoreRaw(root.agentDir);
      expect(() =>
        runAuthProfileWriteTransaction(root.agentDir, (database) =>
          enrollAuthProfileAuthorizationInDatabase(database.db, "agent", {
            profileId: "local",
            expected,
          }),
        ),
      ).toThrow("changed before authorization enrollment");
      expect(readPersistedAuthProfileStoreRaw(root.agentDir)).toEqual(before);
    });
  });

  it("keeps unknown native settlement fenced even after a matching canonical read", async () => {
    const root = await seedRoot("before");
    await withEnvAsync(root.env, async () => {
      const observation = retainAuthProfileAuthorizationObservation(root.agentPath, "local");
      try {
        const raw = readPersistedAuthProfileStoreRaw(root.agentDir);
        observation.prepareRead()(raw);
        const settle = fenceAuthProfileAuthorizationWrite(root.agentPath);
        expect(() => observation.readFact()).toThrow(
          expect.objectContaining({ code: "MCP_AUTHORIZATION_UNAVAILABLE" }),
        );
        settle(false);
        expect(() => observation.prepareRead()).toThrow(
          expect.objectContaining({ code: "MCP_AUTHORIZATION_UNAVAILABLE" }),
        );
        settle(true, raw);
        expect(() => observation.readFact()).toThrow(
          expect.objectContaining({ code: "MCP_AUTHORIZATION_UNAVAILABLE" }),
        );
      } finally {
        observation.dispose();
      }
    });
  });

  it("retains enrollment tombstones through canonical removal and ignores replayed metadata", async () => {
    const root = await seedRoot("before");
    await withEnvAsync(root.env, async () => {
      const raw = runAuthProfileWriteTransaction(
        root.agentDir,
        (database) =>
          enrollAuthProfileAuthorizationInDatabase(database.db, "agent", {
            profileId: "local",
            expected: inspectPersistedAuthProfileStoreRaw(root.agentDir, database),
          }).raw,
      );
      const before = readAuthProfileAuthorizationLifetimes(
        readPersistedAuthProfileStoreRaw(root.agentDir),
      ).local;
      expect(before).toBeTruthy();
      expect(
        await removeAuthProfilesAcrossOwnerStores({
          agentDir: root.agentDir,
          profileIds: ["local"],
        }),
      ).toBe(true);
      const removed = readAuthProfileAuthorizationLifetimes(
        readPersistedAuthProfileStoreRaw(root.agentDir),
      ).local;
      expect(removed).toBeTruthy();
      expect(removed).not.toBe(before);
      await upsertAuthProfileWithLockOrThrow({
        agentDir: root.agentDir,
        profileId: "local",
        credential: apiKey("before-local"),
      });
      const restored = readAuthProfileAuthorizationLifetimes(
        readPersistedAuthProfileStoreRaw(root.agentDir),
      ).local;
      expect(restored).not.toBe(before);
      expect(restored).not.toBe(removed);
      writePersistedAuthProfileStoreRaw(raw, root.agentDir);
      expect(
        readAuthProfileAuthorizationLifetimes(readPersistedAuthProfileStoreRaw(root.agentDir))
          .local,
      ).toBe(restored);
    });
  });
});
