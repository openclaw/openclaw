import { describe, expect, it, vi } from "vitest";
import {
  acquireMemoryIndexReadGeneration,
  withMemoryIndexGeneration,
} from "./manager-index-generation-lease.js";

describe("memory index generation lease", () => {
  it("rejects a native signal that was aborted before admission", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel before admission");
    controller.abort(reason);
    await expect(
      acquireMemoryIndexReadGeneration("/memory-test/pre-aborted.sqlite", controller.signal),
    ).rejects.toMatchObject({
      message: "Memory index generation lease acquisition aborted",
      cause: reason,
    });
  });

  it("removes an aborted queued reader without admitting its successor before publication", async () => {
    const key = "/memory-test/queued-abort.sqlite";
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const publication = withMemoryIndexGeneration(key, "write", async () => {
      entered.resolve();
      await finish.promise;
    });
    await entered.promise;
    const controller = new AbortController();
    const reason = new Error("cancel queued reader");
    const cancelled = acquireMemoryIndexReadGeneration(key, controller.signal);
    const rejected = expect(cancelled).rejects.toMatchObject({ cause: reason });
    const successor = acquireMemoryIndexReadGeneration(key);
    const admitted = vi.fn();
    void successor.then(admitted);
    try {
      controller.abort(reason);
      await rejected;
      await Promise.resolve();
      expect(admitted).not.toHaveBeenCalled();
      finish.resolve();
      await publication;
      await successor;
      expect(admitted).toHaveBeenCalledOnce();
    } finally {
      finish.resolve();
      await publication;
      const release = await successor;
      await release();
    }
  });

  it("keeps an admitted reader until release when its native signal aborts", async () => {
    const key = "/memory-test/admitted-abort.sqlite";
    const controller = new AbortController();
    const release = await acquireMemoryIndexReadGeneration(key, controller.signal);
    const published = vi.fn();
    const publication = withMemoryIndexGeneration(key, "write", async () => {
      published();
    });
    try {
      controller.abort(new Error("cancel admitted reader"));
      await Promise.resolve();
      expect(published).not.toHaveBeenCalled();
    } finally {
      await release();
      await publication;
    }
    expect(published).toHaveBeenCalledOnce();
  });

  it.each([false, true])("admits a second reader with queued publication=%s", async (queued) => {
    const events: string[] = [];
    const generationPath = `/memory-test/second-reader-${queued}.sqlite`;
    const releaseFirstReader = await acquireMemoryIndexReadGeneration(generationPath);
    events.push("first-reader");
    const publish = queued
      ? withMemoryIndexGeneration(generationPath, "write", async () => {
          events.push("publish");
        })
      : Promise.resolve();
    const nextReader = acquireMemoryIndexReadGeneration(generationPath).then(async (release) => {
      events.push("next-reader");
      await release();
    });
    if (queued) {
      await Promise.resolve();
      expect(events).toEqual(["first-reader"]);
      await releaseFirstReader();
    }
    await Promise.all([publish, nextReader]);
    expect(events).toEqual(
      queued ? ["first-reader", "publish", "next-reader"] : ["first-reader", "next-reader"],
    );
    if (!queued) {
      await releaseFirstReader();
    }
  });
});
