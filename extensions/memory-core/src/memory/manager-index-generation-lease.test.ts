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
