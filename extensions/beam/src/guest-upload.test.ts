import { assert, expect, it } from "vitest";
import type { BeamPublisher } from "../upload-operation-api.js";
import { sampleUpload, staffReceipt } from "./beam-store.test-support.js";
import { persistentBeamTestStore } from "./beam.test-support.js";
import { packetDigest, snapshotBytes } from "./packet-state.js";
import { BEAM_MAX_SESSIONS } from "./types.js";

const id = (index: number) => index.toString(16).padStart(32, "0");
const guest = (profileId: string) => ({
  receivedAt: 100,
  publisher: { kind: "guest", profileId } satisfies BeamPublisher,
  assertCurrent() {},
});

it("atomically preserves the initial publisher across competing claims and staff replacements", async () => {
  const { store, keyedStore, close } = await persistentBeamTestStore();
  try {
    const upload = sampleUpload();
    const claims = await Promise.all([
      store.upload(upload, guest("alice")),
      store.upload(upload, guest("bob")),
    ]);
    expect(claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "published", applied: true }),
        "forbidden",
      ]),
    );
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
    ).toMatchObject({ kind: "published", applied: true });
    expect(await store.get(upload.beamId)).toMatchObject({
      publisherProfileId: owner,
      uploaderProfileId: "staff",
      createdAt: 100,
    });
    expect(await store.upload(upload, guest(owner))).toMatchObject({
      kind: "published",
      applied: true,
    });
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
    ).toMatchObject({ kind: "published", applied: true });
    expect((await store.get(id(2)))?.publisherProfileId).toBeUndefined();
  } finally {
    await close();
  }
});

it("bounds concurrent guest creation at twenty while retaining owned refresh and independent publishers", async () => {
  const { store, close } = await persistentBeamTestStore();
  try {
    const outcomes = await Promise.all(
      Array.from({ length: 21 }, (_, index) =>
        store.upload(sampleUpload({ beamId: id(index) }), guest("alice")),
      ),
    );
    expect(
      outcomes.filter(
        (result) => typeof result === "object" && result.kind === "published" && result.applied,
      ),
    ).toHaveLength(20);
    expect(outcomes.filter((result) => result === "publisher-full")).toHaveLength(1);
    const retained = await store.list();
    expect(retained).toHaveLength(20);
    const beamId = retained[0]!.beamId;
    expect(await store.upload(sampleUpload({ beamId, completed: true }), guest("alice"))).toEqual(
      expect.objectContaining({ kind: "published", applied: true }),
    );
    expect(await store.upload(sampleUpload({ beamId: id(30) }), guest("bob"))).toMatchObject({
      kind: "published",
      applied: true,
    });
    expect(await store.delete(beamId)).toBe(true);
    expect(await store.upload(sampleUpload({ beamId: id(31) }), guest("alice"))).toMatchObject({
      kind: "published",
      applied: true,
    });
  } finally {
    await close();
  }
});

it("never lets a guest evict a full catalog, including concurrent last-slot creation", async () => {
  const { store, keyedStore, close } = await persistentBeamTestStore();
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
    expect(finalSlot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "published", applied: true }),
        "catalog-full",
      ]),
    );
    const before = await keyedStore.entries();
    expect(before).toHaveLength(500);
    expect(await store.upload(sampleUpload({ beamId: id(602) }), guest("charlie"))).toBe(
      "catalog-full",
    );
    expect(await keyedStore.entries()).toEqual(before);
    expect(
      await store.upload(sampleUpload({ beamId: id(0), completed: true }), guest("alice")),
    ).toMatchObject({ kind: "published", applied: true });
    expect(await store.upload(sampleUpload({ beamId: id(603) }), staffReceipt(300))).toEqual(
      expect.objectContaining({ kind: "published", applied: true }),
    );
    expect(await keyedStore.entries()).toHaveLength(500);
    expect(await store.get(id(603))).toBeDefined();
    expect(await store.get(id(1))).toBeUndefined();
  } finally {
    await close();
  }
});

it("evicts the same snapshot and image for staff writes through either protocol", async () => {
  const { store, keyedStore, imageStore, close } = await persistentBeamTestStore();
  const image = { digest: "fixture-digest", png: "fixture-bytes", name: "diagram.png" };
  const publish = (index: number, includeImage: boolean) => {
    const upload = sampleUpload({ beamId: id(index) });
    const packetText = snapshotBytes(upload);
    return store.putSnapshot(
      {
        upload,
        packetText,
        digest: packetDigest(packetText),
        ifMatch: null,
        requestId: id(index),
        receivedAt: 1,
        publisher: { kind: "staff" },
        image: includeImage ? image : undefined,
      },
      () => {},
    );
  };
  try {
    // Seed both namespaces at their real limits. Only the session store chooses the victim.
    const keys = Array.from({ length: BEAM_MAX_SESSIONS }, (_, i) => id(i));
    const seedSnapshot = (key: string) =>
      keyedStore.register(key, {
        ...sampleUpload({ beamId: key }),
        presentationDigest: image.digest,
        createdAt: 1,
        receivedAt: 1,
      });
    for (const key of keys.slice(0, 3)) {
      await seedSnapshot(key);
    }
    await Promise.all(keys.slice(3).map(seedSnapshot));
    await Promise.all(keys.toReversed().map((key) => imageStore.register(key, image)));

    expect(await publish(500, true)).toMatchObject({ disposition: "applied" });
    expect(await publish(501, false)).toMatchObject({ disposition: "applied" });
    expect(await store.upload(sampleUpload({ beamId: id(502) }), staffReceipt(2))).toMatchObject({
      applied: true,
    });
    for (const key of keys.slice(0, 3)) {
      expect(await keyedStore.lookup(key)).toBeUndefined();
      expect(await imageStore.lookup(key)).toBeUndefined();
    }
    expect(await keyedStore.entries()).toHaveLength(500);
    expect(await imageStore.entries()).toHaveLength(498);
    expect(await store.getScreenshot?.(id(499), image.digest)).toEqual(image);
    expect(await store.getScreenshot?.(id(500), image.digest)).toEqual(image);
  } finally {
    await close();
  }
});

it("refuses captured authority revoked while the real worker prepares or queues publication", async () => {
  const { store, close } = await persistentBeamTestStore();
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
    expect(await store.upload(sampleUpload(), guest("alice"))).toMatchObject({
      kind: "published",
      applied: true,
    });
  } finally {
    await close();
  }
});
