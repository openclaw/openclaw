import { describe, expect, it, vi } from "vitest";
import { logMemoryVectorDegradedWrite } from "./manager-vector-warning.js";

describe("memory vector degradation warnings", () => {
  it("emits the degraded warning only once for a manager", () => {
    const warn = vi.fn();

    const first = logMemoryVectorDegradedWrite({
      vectorEnabled: true,
      vectorReady: false,
      chunkCount: 3,
      warningShown: false,
      path: "MEMORY.md",
      loadError: "load failed",
      warn,
    });
    const second = logMemoryVectorDegradedWrite({
      vectorEnabled: true,
      vectorReady: false,
      chunkCount: 2,
      warningShown: first,
      path: "memory/2026-04-16.md",
      loadError: "load failed",
      warn,
    });

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "chunks written for MEMORY.md without vector embeddings — chunks_vec not updated (sqlite-vec unavailable: load failed). Vector recall degraded; suppressing duplicate per-file warnings for this manager.",
    );
  });

  it("skips the warning when vector writes are available", () => {
    const warn = vi.fn();

    const shown = logMemoryVectorDegradedWrite({
      vectorEnabled: true,
      vectorReady: true,
      chunkCount: 1,
      warningShown: false,
      path: "MEMORY.md",
      warn,
    });

    expect(shown).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
