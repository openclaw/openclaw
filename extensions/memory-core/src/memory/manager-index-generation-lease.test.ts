// Memory Core tests published-index read and publication ordering.
import { describe, expect, it, vi } from "vitest";
import {
  acquireMemoryIndexReadGeneration,
  withMemoryIndexGeneration,
} from "./manager-index-generation-lease.js";

async function withReadGeneration<T>(key: string, run: () => Promise<T>): Promise<T> {
  const release = await acquireMemoryIndexReadGeneration(key);
  try {
    return await run();
  } finally {
    await release();
  }
}

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

  it("admits another reader into the active generation when no writer is queued", async () => {
    let releaseFirstReader = () => {};
    const firstReaderGate = new Promise<void>((resolve) => {
      releaseFirstReader = resolve;
    });
    const events: string[] = [];
    const generationPath = "/memory-test/shared-reader-generation.sqlite";
    const firstReader = withReadGeneration(generationPath, async () => {
      events.push("first-reader");
      await firstReaderGate;
    });
    await vi.waitFor(() => expect(events).toContain("first-reader"));
    const nextReader = withReadGeneration(generationPath, async () => {
      events.push("next-reader");
    });
    await nextReader;
    expect(events).toEqual(["first-reader", "next-reader"]);
    releaseFirstReader();
    await firstReader;
  });

  it("lets readers continue while publication waits for the active generation", async () => {
    let releaseFirstReader = () => {};
    const firstReaderGate = new Promise<void>((resolve) => {
      releaseFirstReader = resolve;
    });
    const events: string[] = [];
    const generationPath = "/memory-test/reader-before-publish.sqlite";
    const firstReader = withReadGeneration(generationPath, async () => {
      events.push("first-reader-start");
      await firstReaderGate;
      events.push("first-reader-end");
    });
    await vi.waitFor(() => expect(events).toContain("first-reader-start"));
    const publish = withMemoryIndexGeneration(generationPath, "write", async () => {
      events.push("publish");
    });
    await Promise.resolve();
    expect(events).not.toContain("publish");
    releaseFirstReader();
    await Promise.all([firstReader, publish]);
    expect(events).toEqual(["first-reader-start", "first-reader-end", "publish"]);
  });

  it("does not admit a new generation reader ahead of queued publication", async () => {
    let releaseFirstReader = () => {};
    const firstReaderGate = new Promise<void>((resolve) => {
      releaseFirstReader = resolve;
    });
    const events: string[] = [];
    const generationPath = "/memory-test/publish-before-reader.sqlite";
    const firstReader = withReadGeneration(generationPath, async () => {
      events.push("first-reader");
      await firstReaderGate;
    });
    await vi.waitFor(() => expect(events).toContain("first-reader"));
    const publish = withMemoryIndexGeneration(generationPath, "write", async () => {
      events.push("publish");
    });
    const nextReader = withReadGeneration(generationPath, async () => {
      events.push("next-reader");
    });
    releaseFirstReader();
    await Promise.all([firstReader, publish, nextReader]);
    expect(events).toEqual(["first-reader", "publish", "next-reader"]);
  });
});
