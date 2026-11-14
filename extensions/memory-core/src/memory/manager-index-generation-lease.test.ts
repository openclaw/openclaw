import { describe, expect, it, vi } from "vitest";
import {
  acquireMemoryIndexReadGeneration,
  withMemoryIndexGeneration,
} from "./manager-index-generation-lease.js";

describe("memory index generation lease", () => {
  it("holds successor publication behind a predecessor module's admitted reader", async () => {
    const key = "/memory-test/module-overlap.sqlite";
    const release = await acquireMemoryIndexReadGeneration(key);
    vi.resetModules();
    const successor = await import("./manager-index-generation-lease.js");
    expect(successor.withMemoryIndexGeneration).not.toBe(withMemoryIndexGeneration);
    const publish = vi.fn(async () => {});
    const pending = successor.withMemoryIndexGeneration(key, "write", publish);
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await release();
      await pending;
    }
    expect(publish).toHaveBeenCalledOnce();
  });

  it("shares reindex exclusion across overlapping module generations", async () => {
    const predecessor = await import("./manager-reindex-lock.js");
    const lock = await predecessor.waitForMemoryReindexLock("/memory-test/module-reindex.sqlite");
    vi.resetModules();
    const successor = await import("./manager-reindex-lock.js");
    expect(successor.waitForMemoryReindexLock).not.toBe(predecessor.waitForMemoryReindexLock);
    const entered = vi.fn();
    const pending = successor
      .waitForMemoryReindexLock("/memory-test/module-reindex.sqlite", {
        waitForActive: true,
      })
      .then((next) => {
        entered();
        return next;
      });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(entered).not.toHaveBeenCalled();
    } finally {
      await lock.release();
      await (await pending).release();
    }
    expect(entered).toHaveBeenCalledOnce();
  });

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
