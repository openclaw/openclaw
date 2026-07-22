// Terminal note output tests cover scoped stream routing for embedded CLI flows.
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import { note, withNoteOutput } from "./note.js";

describe("withNoteOutput", () => {
  it("keeps note rendering on the scoped output across async work", async () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await withNoteOutput(process.stderr, async () => {
        await Promise.resolve();
        note("Repaired deterministic test fixture.", "Doctor changes");
      });

      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stderrWrite).toHaveBeenCalled();
      expect(stderrWrite.mock.calls.map(([value]) => String(value)).join("\n")).toContain(
        "Repaired deterministic test fixture.",
      );
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });
});
