import { assert, expect, it } from "vitest";
import type { BeamPublisher } from "../upload-operation-api.js";
import { sampleUpload, staffReceipt } from "./beam-store.test-support.js";
import { persistentBeamTestStore } from "./beam.test-support.js";
import { BEAM_MAX_SESSIONS } from "./types.js";

const id = (index: number) => index.toString(16).padStart(32, "0");
const guest = (profileId: string) => ({
  receivedAt: 100,
  publisher: { kind: "guest", profileId } satisfies BeamPublisher,
  assertCurrent() {},
});

it("atomically preserves the initial publisher across competing claims and staff replacements", async () => {
  const { store, keyedStore, close } = persistentBeamTestStore();
  try {
    const upload = sampleUpload();
    const claims = await Promise.all([
      store.upload(upload, guest("alice")),
      store.upload(upload, guest("bob")),
    ]);
    expect(claims.toSorted()).toEqual(["applied", "forbidden"]);
    const owner = (await store.get(upload.beamId))?.publisherProfileId;
    expect(["alice", "bob"]).toContain(owner);
    assert(owner, "winning publisher must be recorded");
    const foreign = owner === "alice" ? "bob" : "alice";
    expect(
      await store.upload(sampleUpload({ updatedAt: "2020-01-01T00:00:00Z" }), guest(foreign)),
    ).toBe("forbidden");
    expect(
      await store.upload(upload, {
        ...staffReceipt(200),
        publisher: { kind: "staff", profileId: "staff" },
      }),
    ).toBe("applied");
    expect(await store.get(upload.beamId)).toMatchObject({
      publisherProfileId: owner,
      uploaderProfileId: "staff",
      createdAt: 100,
    });
    expect(await store.upload(upload, guest(owner))).toBe("applied");
    await keyedStore.register(id(2), {
      ...sampleUpload({ beamId: id(2) }),
      createdAt: 1,
      receivedAt: 1,
      uploaderProfileId: "alice",
    });
    expect(await store.upload(sampleUpload({ beamId: id(2) }), guest("alice"))).toBe("forbidden");
    expect(
      await store.upload(sampleUpload({ beamId: id(2) }), {
        ...staffReceipt(200),
        publisher: { kind: "staff", profileId: "alice" },
      }),
    ).toBe("applied");
    expect((await store.get(id(2)))?.publisherProfileId).toBeUndefined();
  } finally {
    await close();
  }
});

it("bounds concurrent guest creation at twenty while retaining owned refresh and independent publishers", async () => {
  const { store, close } = persistentBeamTestStore();
  try {
    const outcomes = await Promise.all(
      Array.from({ length: 21 }, (_, index) =>
        store.upload(sampleUpload({ beamId: id(index) }), guest("alice")),
      ),
    );
    expect(outcomes.filter((result) => result === "applied")).toHaveLength(20);
    expect(outcomes.filter((result) => result === "publisher-full")).toHaveLength(1);
    const retained = await store.list();
    expect(retained).toHaveLength(20);
    const beamId = retained[0]!.beamId;
    expect(await store.upload(sampleUpload({ beamId, completed: true }), guest("alice"))).toBe(
      "applied",
    );
    expect(await store.upload(sampleUpload({ beamId: id(30) }), guest("bob"))).toBe("applied");
    expect(await store.delete(beamId)).toBe(true);
    expect(await store.upload(sampleUpload({ beamId: id(31) }), guest("alice"))).toBe("applied");
  } finally {
    await close();
  }
});

it("never lets a guest evict a full catalog, including concurrent last-slot creation", async () => {
  const { store, keyedStore, close } = persistentBeamTestStore();
  try {
    await store.upload(sampleUpload({ beamId: id(0) }), guest("alice"));
    await Promise.all(
      Array.from({ length: BEAM_MAX_SESSIONS - 2 }, (_, index) => {
        const beamId = id(index + 1);
        return keyedStore.register(beamId, {
          ...sampleUpload({ beamId }),
          createdAt: 1,
          receivedAt: 1,
        });
      }),
    );
    const finalSlot = await Promise.all([
      store.upload(sampleUpload({ beamId: id(600) }), guest("alice")),
      store.upload(sampleUpload({ beamId: id(601) }), guest("bob")),
    ]);
    expect(finalSlot.toSorted()).toEqual(["applied", "catalog-full"]);
    const before = await keyedStore.entries();
    expect(before).toHaveLength(500);
    expect(await store.upload(sampleUpload({ beamId: id(602) }), guest("charlie"))).toBe(
      "catalog-full",
    );
    expect(await keyedStore.entries()).toEqual(before);
    expect(
      await store.upload(sampleUpload({ beamId: id(0), completed: true }), guest("alice")),
    ).toBe("applied");
    expect(await store.upload(sampleUpload({ beamId: id(603) }), staffReceipt(300))).toBe(
      "applied",
    );
    expect(await keyedStore.entries()).toHaveLength(500);
    expect(await store.get(id(603))).toBeDefined();
    expect(await store.get(id(1))).toBeUndefined();
  } finally {
    await close();
  }
});

it("refuses captured authority revoked while the real worker prepares or queues publication", async () => {
  const { store, close } = persistentBeamTestStore();
  try {
    let current = true;
    const receipt = {
      ...guest("alice"),
      assertCurrent() {
        if (!current) {
          throw new Error("original Visitor grant ended");
        }
      },
    };
    const pending = store.upload(sampleUpload(), receipt);
    current = false;
    await expect(pending).rejects.toThrow();
    // A new invitation does not replace the original request's closed-over authority.
    await expect(store.upload(sampleUpload(), receipt)).rejects.toThrow(
      "original Visitor grant ended",
    );
    expect(await store.get(sampleUpload().beamId)).toBeUndefined();
    expect(await store.upload(sampleUpload(), guest("alice"))).toBe("applied");
  } finally {
    await close();
  }
});
