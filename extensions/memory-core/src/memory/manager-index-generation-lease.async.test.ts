import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireMemoryIndexReadGeneration,
  withMemoryIndexPublishGeneration,
} from "./manager-index-generation-lease.js";
import type { MemorySqliteLeaseHandle } from "./manager-sqlite-lease.js";

const leases = vi.hoisted(() => ({
  acquire: vi.fn<typeof import("./manager-sqlite-lease.js").tryAcquireMemorySqliteLease>(),
  acquireWriter: vi.fn<typeof import("./manager-sqlite-lease.js").acquireMemorySqliteWriterLease>(),
}));
vi.mock("./manager-sqlite-lease.js", () => ({
  tryAcquireMemorySqliteLease: leases.acquire,
  acquireMemorySqliteWriterLease: leases.acquireWriter,
}));

beforeEach(() => {
  leases.acquire.mockReset();
  leases.acquireWriter.mockReset();
});

describe("memory generation lease cleanup", () => {
  it.each([false, true])(
    "keeps publication and queued readers waiting for both releases (release failure: %s)",
    async (failRelease) => {
      const generationStarted = createDeferred<void>();
      const generationGate = createDeferred<void>();
      const admissionStarted = createDeferred<void>();
      const admissionGate = createDeferred<void>();
      const releaseError = new Error("generation release failed");
      const events: string[] = [];
      leases.acquire.mockResolvedValueOnce({
        release: async () => {
          generationStarted.resolve();
          await generationGate.promise;
          if (failRelease) {
            throw releaseError;
          }
        },
      });
      leases.acquire.mockResolvedValue({ release: async () => {} });
      leases.acquireWriter.mockResolvedValue({
        release: async () => {
          admissionStarted.resolve();
          await admissionGate.promise;
        },
      });
      const databasePath = `/memory-generation-release-${failRelease}.sqlite`;
      const publication = withMemoryIndexPublishGeneration(databasePath, async () => {
        events.push("published");
      }).then(
        () => events.push("released"),
        (error: unknown) => {
          events.push("release-failed");
          return error;
        },
      );
      await generationStarted.promise;
      const nextReader = acquireMemoryIndexReadGeneration(databasePath).then(async (release) => {
        events.push("next-reader");
        await release();
      });
      try {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(events).toEqual(["published"]);
        expect(leases.acquire).toHaveBeenCalledTimes(1);
        generationGate.resolve();
        await admissionStarted.promise;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(events).toEqual(["published"]);
        expect(leases.acquire).toHaveBeenCalledTimes(1);
      } finally {
        generationGate.resolve();
        admissionGate.resolve();
        await Promise.all([publication, nextReader]);
      }
      expect(events).toContain("next-reader");
      if (failRelease) {
        expect(await publication).toBe(releaseError);
      } else {
        expect(events).toContain("released");
      }
    },
  );

  it("drains a lease delivered after cancellation before admitting the next local publisher", async () => {
    const acquired = createDeferred<MemorySqliteLeaseHandle>();
    const acquisitionStarted = createDeferred<void>();
    const releaseStarted = createDeferred<void>();
    const releaseGate = createDeferred<void>();
    const admissionRelease = vi.fn(async () => {});
    const generationRelease = vi.fn(async () => {
      releaseStarted.resolve();
      await releaseGate.promise;
    });
    leases.acquire
      .mockResolvedValueOnce({ release: admissionRelease })
      .mockImplementationOnce(async () => {
        acquisitionStarted.resolve();
        return acquired.promise;
      })
      .mockResolvedValue({ release: async () => {} });
    const abortReason = new Error("search canceled");
    const controller = new AbortController();
    const databasePath = "/memory-generation-late-acquisition.sqlite";
    const reader = acquireMemoryIndexReadGeneration(databasePath, controller.signal).catch(
      (error: unknown) => error,
    );
    await acquisitionStarted.promise;
    controller.abort(abortReason);
    acquired.resolve({ release: generationRelease });
    await releaseStarted.promise;
    let published = false;
    leases.acquireWriter.mockResolvedValue({ release: async () => {} });
    const nextPublication = withMemoryIndexPublishGeneration(databasePath, async () => {
      published = true;
    });
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(published).toBe(false);
      expect(admissionRelease).not.toHaveBeenCalled();
    } finally {
      releaseGate.resolve();
      await nextPublication;
    }
    expect(await reader).toMatchObject({ cause: abortReason });
    expect(generationRelease).toHaveBeenCalledTimes(1);
    expect(admissionRelease).toHaveBeenCalledTimes(1);
    expect(published).toBe(true);
  });
});
