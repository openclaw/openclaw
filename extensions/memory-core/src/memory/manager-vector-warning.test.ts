// Memory Core tests cover manager vector warning plugin behavior.
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
      loadError: "load failed",
      warn,
    });
    const second = logMemoryVectorDegradedWrite({
      vectorEnabled: true,
      vectorReady: false,
      chunkCount: 2,
      warningShown: first,
      loadError: "load failed",
      warn,
    });

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
<<<<<<< HEAD
      "memory_index_chunks_vec not updated — sqlite-vec unavailable: load failed. Vector recall degraded. Further duplicate warnings suppressed.",
=======
      "chunks_vec not updated — sqlite-vec unavailable: load failed. Vector recall degraded. Further duplicate warnings suppressed.",
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    );
  });

  it("blames embedding readiness when sqlite-vec loaded but no dimensions resolved", () => {
    const warn = vi.fn();

    const shown = logMemoryVectorDegradedWrite({
      vectorEnabled: true,
      vectorReady: false,
      chunkCount: 3,
      warningShown: false,
      warn,
    });

    expect(shown).toBe(true);
    expect(warn).toHaveBeenCalledWith(
<<<<<<< HEAD
      "memory_index_chunks_vec not updated — semantic vector embeddings unavailable — no vector dimensions resolved. Vector recall degraded. Further duplicate warnings suppressed.",
=======
      "chunks_vec not updated — semantic vector embeddings unavailable — no vector dimensions resolved. Vector recall degraded. Further duplicate warnings suppressed.",
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    );
  });

  it("skips the warning when vector writes are available", () => {
    const warn = vi.fn();

    const shown = logMemoryVectorDegradedWrite({
      vectorEnabled: true,
      vectorReady: true,
      chunkCount: 1,
      warningShown: false,
      warn,
    });

    expect(shown).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
