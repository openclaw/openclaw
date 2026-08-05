import { describe, expect, it, vi } from "vitest";
import {
  createMemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "./memory-write-provenance.js";

describe("memory write provenance", () => {
  it("maps observer paths without rewriting backend paths", async () => {
    const readFile = vi.fn(async () => "before");
    const writeFile = vi.fn(async (_path: string, _content: string) => {});
    const remove = vi.fn(async (_path: string) => {});
    const clearAfterDelete = vi.fn(async () => {});
    const observer = {
      classifies: vi.fn(() => true),
      write: vi.fn(async ({ commit }: { commit: () => Promise<void> }) => await commit()),
      clearAfterDelete,
    };
    const operations = withMemoryWriteProvenance(
      { readFile, writeFile, remove },
      observer,
      (backendPath) => `/host/workspace/${backendPath}`,
    );

    await operations.writeFile("memory/note.md", "after");
    await operations.remove("memory/note.md");

    expect(observer.classifies).toHaveBeenCalledWith("/host/workspace/memory/note.md");
    expect(observer.write).toHaveBeenCalledWith(
      expect.objectContaining({ absolutePath: "/host/workspace/memory/note.md" }),
    );
    expect(readFile).toHaveBeenCalledWith("memory/note.md");
    expect(writeFile).toHaveBeenCalledWith("memory/note.md", "after");
    expect(remove).toHaveBeenCalledWith("memory/note.md");
    expect(clearAfterDelete).toHaveBeenCalledWith("/host/workspace/memory/note.md");
  });

  it("rolls provenance back when the filesystem write fails", async () => {
    let provenance = "before";
    const observer = createMemoryWriteProvenanceObserver({
      mutationRoot: process.cwd(),
      workspaceDir: process.cwd(),
      plan: {
        recordWriteProvenance: async () => {
          provenance = "predicted";
          return async () => {
            provenance = "before";
          };
        },
      },
      resolveOriginClass: () => "untrusted",
      now: () => 1,
    });
    const commit = vi.fn(async () => {
      throw new Error("disk full");
    });

    await expect(
      observer?.write({
        absolutePath: `${process.cwd()}/MEMORY.md`,
        contentBefore: "before",
        contentAfter: "after",
        commit,
      }),
    ).rejects.toThrow("disk full");
    expect(provenance).toBe("before");
    expect(commit).toHaveBeenCalledOnce();
  });
});
