import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { runPostCompactionSideEffects } from "./compaction-hooks.js";

const { emitSessionTranscriptUpdate } = vi.hoisted(() => ({
  emitSessionTranscriptUpdate: vi.fn(),
}));
vi.mock("../../sessions/transcript-events.js", () => ({ emitSessionTranscriptUpdate }));
vi.mock("../../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManagerCore: vi.fn(),
}));

it.each(["allow", "refuse"] as const)(
  "awaits post-compaction authority before publishing (%s)",
  async (decision) => {
    emitSessionTranscriptUpdate.mockClear();
    const entered = createDeferredCore();
    const authority = createDeferredCore();
    const pending = runPostCompactionSideEffects({
      sessionFile: "synthetic-compaction",
      assertActive: async () => {
        entered.resolve();
        await authority.promise;
      },
    });
    await entered.promise;
    expect(emitSessionTranscriptUpdate).not.toHaveBeenCalled();
    if (decision === "refuse") {
      const failure = new Error("Compaction owner retired");
      const rejected = expect(pending).rejects.toBe(failure);
      authority.reject(failure);
      await rejected;
      expect(emitSessionTranscriptUpdate).not.toHaveBeenCalled();
    } else {
      authority.resolve();
      await pending;
      expect(emitSessionTranscriptUpdate).toHaveBeenCalledExactlyOnceWith({
        sessionFile: "synthetic-compaction",
        sessionKey: undefined,
      });
    }
  },
);
