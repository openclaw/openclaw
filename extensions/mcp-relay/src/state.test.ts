import { createPrivateKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStateFixture } from "./state.test-helpers.js";

const CLIENT = { id: "synthetic-client", name: "Synthetic client" };

async function paired(f: ReturnType<typeof createStateFixture>) {
  const state = f.open();
  await state.initialize();
  await state.issue("pair-hash", 1_000, 0);
  await state.createGrant({ grantId: "gr_one", codeHash: "pair-hash", client: CLIENT }, 10);
  return state;
}

describe("MCP relay durable authority", () => {
  it("keeps one Ed25519 identity across concurrent startup and restart, bound to its relay", async () => {
    const f = createStateFixture();
    const identities = await Promise.all([f.open().initialize(), f.open().initialize()]);
    expect(identities[0]).toEqual(identities[1]);
    expect(
      createPrivateKey({
        key: Buffer.from(identities[0].privateKey, "base64url"),
        type: "pkcs8",
        format: "der",
      }).asymmetricKeyType,
    ).toBe("ed25519");
    await expect(f.open().initialize()).resolves.toEqual(identities[0]);
    const saved = f.persisted();
    await expect(f.open("https://other.example").initialize()).rejects.toThrow("bound to");
    expect(f.persisted()).toBe(saved);
  });

  it("never replaces unreadable state or generates an identity after a storage error", async () => {
    const f = createStateFixture();
    await f.open().initialize();
    const saved = f.persisted();
    f.effects.failure = new Error("Storage unavailable");
    await expect(f.open().initialize()).rejects.toThrow("Storage unavailable");
    expect(f.persisted()).toBe(saved);
    f.effects.failure = undefined;
    f.corrupt();
    const corrupted = f.persisted();
    await expect(f.open().initialize()).rejects.toThrow("Restore a valid OpenClaw state backup");
    expect(f.persisted()).toBe(corrupted);
  });

  it("atomically consumes a code once across concurrent grant requests and restart", async () => {
    const f = createStateFixture();
    const state = f.open();
    await state.initialize();
    await state.issue("hash", 1_000, 0);
    const results = await Promise.all(
      ["gr_a", "gr_b"].map((grantId) =>
        f.open().createGrant({ grantId, codeHash: "hash", client: CLIENT }, 10),
      ),
    );
    expect(results.toSorted((left, right) => Number(left) - Number(right))).toEqual([false, true]);
    const grants = await f.open().grants();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      clientId: CLIENT.id,
      clientName: CLIENT.name,
      createdAt: 10,
    });
    await expect(
      state.createGrant({ grantId: "gr_c", codeHash: "hash", client: CLIENT }, 11),
    ).resolves.toBe(false);
    await expect(
      state.createGrant({ grantId: "gr_d", codeHash: "unknown", client: CLIENT }, 11),
    ).resolves.toBe(false);
    await state.issue("expired", 20, 0);
    await expect(
      state.createGrant({ grantId: "gr_e", codeHash: "expired", client: CLIENT }, 20),
    ).resolves.toBe(false);
  });

  it("retains revocation tombstones and last-use facts through restart without resurrecting grant IDs", async () => {
    const f = createStateFixture();
    const state = await paired(f);
    await expect(state.authorize("unknown", 20)).resolves.toBe(false);
    await expect(state.authorize("gr_one", 20)).resolves.toBe(true);
    await expect(f.open().grants()).resolves.toEqual([
      {
        grantId: "gr_one",
        clientId: CLIENT.id,
        clientName: CLIENT.name,
        createdAt: 10,
        lastUsedAt: 20,
      },
    ]);
    await expect(state.revoke("gr_one", 30)).resolves.toBe(true);
    await expect(f.open().authorize("gr_one", 40)).resolves.toBe(false);
    await state.issue("fresh", 1_000, 40);
    await expect(
      state.createGrant({ grantId: "gr_one", codeHash: "fresh", client: CLIENT }, 40),
    ).resolves.toBe(false);
    await expect(
      state.createGrant({ grantId: "gr_two", codeHash: "fresh", client: CLIENT }, 40),
    ).resolves.toBe(true);
    expect((await f.open().grants())[0]).toMatchObject({ lastUsedAt: 20, revokedAt: 30 });
  });

  it("does not overwrite a concurrent revocation with an authorization prepared earlier", async () => {
    const f = createStateFixture();
    const state = await paired(f);
    f.effects.beforeCompare = async () => {
      await f.open().revoke("gr_one", 20);
    };
    await expect(state.authorize("gr_one", 30)).resolves.toBe(false);
    await expect(f.open().grants()).resolves.toEqual([
      {
        grantId: "gr_one",
        clientId: CLIENT.id,
        clientName: CLIENT.name,
        createdAt: 10,
        revokedAt: 20,
      },
    ]);
  });

  it.each(["before creation", "while creation is pending"])(
    "preserves a remote revocation received %s through restart",
    async (ordering) => {
      const f = createStateFixture();
      const state = f.open();
      await state.initialize();
      await state.issue("hash", 1_000, 0);
      await expect(state.revoke("gr_one", 10)).resolves.toBe(false);
      await expect(state.grants()).resolves.toEqual([]);
      if (ordering === "before creation") {
        await state.recordRevocation("gr_one", 20);
      } else {
        f.effects.beforeCompare = async () => {
          await f.open().recordRevocation("gr_one", 20);
        };
      }
      await expect(
        state.createGrant({ grantId: "gr_one", codeHash: "hash", client: CLIENT }, 10),
      ).resolves.toBe(false);
      const reopened = f.open();
      await reopened.initialize();
      await expect(reopened.authorize("gr_one", 30)).resolves.toBe(false);
      await reopened.recordRevocation("gr_one", 40);
      await expect(reopened.grants()).resolves.toEqual([{ grantId: "gr_one", revokedAt: 20 }]);
      await expect(
        reopened.createGrant({ grantId: "gr_one", codeHash: "hash", client: CLIENT }, 50),
      ).resolves.toBe(false);
    },
  );

  it("rejects oversized admission without consuming the code and preserves space for revocation", async () => {
    const f = createStateFixture();
    const state = f.open();
    await state.initialize();
    await state.issue("hash", 1_000, 0);
    await expect(
      state.createGrant(
        {
          grantId: "gr_big",
          codeHash: "hash",
          client: { id: CLIENT.id, name: "x".repeat(512 * 1024) },
        },
        10,
      ),
    ).rejects.toThrow("capacity");
    await expect(
      state.createGrant(
        {
          grantId: "gr_big",
          codeHash: "hash",
          client: { id: CLIENT.id, name: "x".repeat(511 * 1024) },
        },
        10,
      ),
    ).resolves.toBe(true);
    await expect(state.authorize("gr_big", 20)).resolves.toBe(true);
    await expect(state.recordRevocation(`gr_${"x".repeat(1_024)}`, 25)).rejects.toThrow("capacity");
    await state.recordRevocation("gr_big", 30);
    await expect(f.open().authorize("gr_big", 40)).resolves.toBe(false);
    expect((await f.open().grants())[0]).toMatchObject({ lastUsedAt: 20, revokedAt: 30 });
  });

  it("never retries uncertain committed writes and leaves their durable grant consumed", async () => {
    const f = createStateFixture();
    const state = f.open();
    await state.initialize();
    await state.issue("hash", 1_000, 0);
    f.effects.afterCommit = () => {
      throw new Error("Reply lost after commit");
    };
    await expect(
      state.createGrant({ grantId: "gr_one", codeHash: "hash", client: CLIENT }, 10),
    ).rejects.toThrow("Reply lost");
    await expect(f.open().grants()).resolves.toHaveLength(1);
    await expect(
      state.createGrant({ grantId: "gr_two", codeHash: "hash", client: CLIENT }, 20),
    ).resolves.toBe(false);
  });

  it("refuses a pairing code that expires while grant persistence is pending", async () => {
    const f = createStateFixture();
    const state = f.open();
    await state.initialize();
    await state.issue("hash", 1_000, 0);
    const saved = f.persisted();
    f.effects.beforeCompare = async () => {
      f.setNow(1_000);
    };
    await expect(
      state.createGrant({ grantId: "gr_one", codeHash: "hash", client: CLIENT }, 10),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(f.persisted()).toBe(saved);
  });

  it.each(["issue", "revoke"] as const)(
    "carries the %s command authority into pending persistence",
    async (operation) => {
      const f = createStateFixture();
      const state = await paired(f);
      const saved = f.persisted();
      let commandCurrent = true;
      const assertCommandCurrent = () => {
        if (!commandCurrent) {
          throw new Error("Command authority revoked");
        }
      };
      f.effects.beforeCompare = async () => {
        commandCurrent = false;
      };
      const pending =
        operation === "issue"
          ? state.issue("fresh", 1_000, 30, assertCommandCurrent)
          : state.revoke("gr_one", 30, assertCommandCurrent);
      await expect(pending).rejects.toThrow("Command authority revoked");
      expect(f.persisted()).toBe(saved);
    },
  );

  it("carries service lifetime through pending write admission", async () => {
    const f = createStateFixture();
    const state = await paired(f);
    const saved = f.persisted();
    f.effects.beforeCompare = async () => {
      f.stop();
    };
    await expect(state.revoke("gr_one", 30)).rejects.toThrow("Service stopped");
    expect(f.persisted()).toBe(saved);
  });
});
