import { expect, it } from "vitest";
import { releaseSource, sampleUpload, staffReceipt } from "./beam-store.test-support.js";
import { persistentBeamTestStore } from "./beam.test-support.js";
import { createBeamSessionCatalog } from "./session-catalog.js";

const publisher = (profileId = "source-publisher", receivedAt = 100) => ({
  ...staffReceipt(receivedAt),
  publisher: { kind: "staff" as const, profileId },
});

it("keeps ordinary snapshots read-only until the original verified publisher releases them", async () => {
  const { store, close } = await persistentBeamTestStore();
  try {
    const result = await store.upload(sampleUpload(), publisher());
    expect(result).toMatchObject({ kind: "published", applied: true });
    if (typeof result !== "object" || result.kind !== "published") {
      throw new Error("missing publication");
    }
    const source = (await store.get(sampleUpload().beamId))!;
    expect(
      (await createBeamSessionCatalog(store).list({ agentId: "main" }))[0]?.sessions[0]
        ?.canContinue,
    ).toBe(false);
    await expect(store.reserveContinuation(source, "main", () => {})).rejects.toThrow(
      "source still owns",
    );
    const release = { ...sampleUpload(), handoffId: result.id };
    expect(await store.upload(release, publisher("foreign-staff"))).toBe("forbidden");
    expect(await store.upload(release, staffReceipt(200))).toBe("forbidden");
    expect(await store.upload(release, publisher())).toMatchObject({
      kind: "handoff",
      accepted: true,
    });
  } finally {
    await close();
  }
});

it("freezes released history and expiry across lost acknowledgments, stale snapshots, and reservation retries", async () => {
  const { store, keyedStore, handoffStore, close } = await persistentBeamTestStore();
  try {
    const generation = await releaseSource(store);
    const before = await keyedStore.entries();
    const metadata = await handoffStore.entries();
    expect(metadata[0]?.value).not.toHaveProperty("items");
    expect(metadata[0]?.expiresAt).toBeUndefined();
    expect(
      await store.upload(
        { ...sampleUpload(), handoffId: generation },
        publisher("source-publisher", 200),
      ),
    ).toEqual({ kind: "handoff", id: generation, accepted: true });
    expect(
      await store.upload(
        sampleUpload({ updatedAt: "2026-08-01T12:00:00Z", title: "Late source turn" }),
        publisher(),
      ),
    ).toEqual({ kind: "handoff", id: generation, accepted: false });
    expect(await store.upload(sampleUpload({ handoffId: "f".repeat(32) }), publisher())).toEqual({
      kind: "handoff",
      id: generation,
      accepted: false,
    });
    expect(await keyedStore.entries()).toEqual(before);
    const source = (await store.get(sampleUpload().beamId))!;
    const binding = await store.reserveContinuation(source, "main", () => {});
    const retried = await store.reserveContinuation(
      (await store.get(source.beamId))!,
      "other",
      () => {},
    );
    expect(retried.session.continuation?.sessionKey).toBe(binding.session.continuation?.sessionKey);
    binding.release();
    retried.release();
  } finally {
    await close();
  }
});

it("does not recreate an expired pre-release incarnation from a delayed release", async () => {
  const { store, close } = await persistentBeamTestStore();
  try {
    const published = await store.upload(sampleUpload(), publisher());
    if (typeof published !== "object" || published.kind !== "published") {
      throw new Error("missing publication");
    }
    await store.delete(sampleUpload().beamId);
    const staleRelease = { ...sampleUpload(), handoffId: published.id };
    expect(await store.upload(staleRelease, publisher())).toBe("handoff-conflict");
    expect(await store.get(sampleUpload().beamId)).toBeUndefined();
    const replacement = await store.upload(sampleUpload(), publisher());
    expect(replacement).not.toMatchObject({ id: published.id });
    expect(await store.upload(staleRelease, publisher())).toBe("handoff-conflict");
  } finally {
    await close();
  }
});

it("retains the destination and source write fence after native snapshot archive", async () => {
  const { store, keyedStore, close } = await persistentBeamTestStore();
  try {
    const generation = await releaseSource(store);
    const source = (await store.get(sampleUpload().beamId))!;
    const binding = await store.reserveContinuation(source, "main", () => {});
    await binding.beginCreate(() => {});
    await binding.complete(() => {});
    await store.delete(source.beamId);
    binding.assertCurrent();
    expect(await keyedStore.entries()).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect(await store.upload(sampleUpload(), publisher())).toEqual({
      kind: "handoff",
      id: generation,
      accepted: false,
    });
    const catalog = createBeamSessionCatalog(store);
    const [host] = await catalog.list({ agentId: "other", search: source.beamId.slice(0, 12) });
    expect(host?.sessions[0]?.sessionKey).toBe(binding.session.continuation?.sessionKey);
    const resolved = await catalog.resolveGatewayConversation!({
      hostId: "gateway",
      threadId: source.beamId,
      agentId: "other",
      assertCurrent() {},
    });
    expect(resolved?.sessionKey).toBe(binding.session.continuation?.sessionKey);
    resolved?.release();
    binding.release();
  } finally {
    await close();
  }
});
