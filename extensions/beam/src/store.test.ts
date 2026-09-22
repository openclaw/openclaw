import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it } from "vitest";
import { memoryStore, sampleUpload } from "./beam-store.test-support.js";
import { createBeamStore } from "./store.js";
import type { BeamStoredSession } from "./types.js";

describe("Beam upload store", () => {
  it.each([
    ["older", "2026-07-20T12:00:00.000099Z", false],
    ["same completed", "2026-07-20T08:00:00.000100-04:00", false],
    ["newer", "2026-07-20T12:00:00.000101Z", true],
  ] as const)(
    "rechecks the %s revision after a competing upload",
    async (_, updatedAt, accepted) => {
      const store = memoryStore();
      const competing: BeamStoredSession = {
        ...sampleUpload({ updatedAt: "2026-07-20T12:00:00.000100Z", completed: true }),
        uploaderProfileId: "competing-publisher",
        createdAt: 50,
        receivedAt: 75,
      };
      const compare = store.keyedStore.compareAndApply.getMockImplementation();
      if (!compare) {
        throw new Error("Beam test store has no comparison implementation");
      }
      store.keyedStore.compareAndApply.mockImplementationOnce(async (...args) => {
        store.values.set(competing.beamId, competing);
        return compare(...args);
      });
      const upload = sampleUpload({ updatedAt, title: "Candidate snapshot" });

      expect(await store.upload(upload, { receivedAt: 100 })).toBe(accepted);
      expect(await store.get(upload.beamId)).toEqual(
        accepted ? { ...upload, createdAt: 50, receivedAt: 100 } : competing,
      );
    },
  );

  it.each(["observe", "compareAndApply"] as const)(
    "refuses uploads when %s support is missing",
    async (missing) => {
      const { keyedStore, values } = memoryStore();
      const store = createBeamStore({
        state: { openKeyedStore: () => ({ ...keyedStore, [missing]: undefined }) },
      } as unknown as PluginRuntime);
      await expect(store.upload(sampleUpload(), { receivedAt: 100 })).rejects.toThrow(
        "require plugin-state observe and compareAndApply",
      );
      expect(values.size).toBe(0);
      expect(keyedStore.observe).not.toHaveBeenCalled();
      expect(keyedStore.compareAndApply).not.toHaveBeenCalled();
    },
  );

  it("returns an uncertain store failure without replaying the upload", async () => {
    const store = memoryStore();
    store.keyedStore.compareAndApply.mockRejectedValueOnce(new Error("unknown write outcome"));
    await expect(store.upload(sampleUpload(), { receivedAt: 100 })).rejects.toThrow(
      "unknown write outcome",
    );
    expect(store.keyedStore.compareAndApply).toHaveBeenCalledTimes(1);
    expect(store.values.size).toBe(0);
  });

  it("captures the upload and receipt before waiting for observation", async () => {
    const store = memoryStore();
    const upload = sampleUpload();
    const original = structuredClone(upload);
    const receipt = { receivedAt: 100, uploaderProfileId: "verified-publisher" };
    const pending = store.upload(upload, receipt);
    upload.title = "Changed after submission";
    for (const item of upload.items) {
      item.text = "Changed after submission";
    }
    receipt.receivedAt = 200;
    receipt.uploaderProfileId = "changed-publisher";
    expect(await pending).toBe(true);
    expect(await store.get(original.beamId)).toEqual({
      ...original,
      createdAt: 100,
      receivedAt: 100,
      uploaderProfileId: "verified-publisher",
    });
  });
});
