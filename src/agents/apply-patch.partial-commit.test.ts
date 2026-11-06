import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { applyPatch, createMemoryPatchSandbox } from "./apply-patch.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let dir: string;
beforeEach(() => {
  dir = tempDirs.make("openclaw-patch-partial-");
});

const patch = (...hunks: string[]) => ["*** Begin Patch", ...hunks, "*** End Patch"].join("\n");
const update = (file: string, before: string, after: string) =>
  `*** Update File: ${file}\n@@\n-${before}\n+${after}`;
const PARTIAL =
  "The patch stopped partway; these earlier changes were applied and not rolled back:";

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error)) {
    throw new Error("expected the patch to reject");
  }
  return error;
}

describe("applyPatch partial commit reporting", () => {
  it("names earlier applied hunks when a later add fails during commit", async () => {
    await fs.writeFile(path.join(dir, "existing.txt"), "keep\n");
    await fs.writeFile(path.join(dir, "notes.txt"), "one\n");

    const error = await rejection(
      applyPatch(
        patch(
          "*** Add File: created.txt\n+new",
          update("notes.txt", "one", "two"),
          "*** Add File: existing.txt\n+clobber",
        ),
        { cwd: dir },
      ),
    );

    expect(error.message).toBe(
      [
        "Cannot create existing.txt: the file already exists. " +
          'Use "*** Update File: existing.txt" to change it, or delete it earlier in the same patch.',
        PARTIAL,
        "A created.txt",
        "M notes.txt",
        "Re-read these files before retrying, and do not resend the hunks already applied.",
      ].join("\n"),
    );
    await expect(fs.readFile(path.join(dir, "created.txt"), "utf8")).resolves.toBe("new\n");
    await expect(fs.readFile(path.join(dir, "notes.txt"), "utf8")).resolves.toBe("two\n");
  });

  it("keeps a first-hunk failure message unchanged", async () => {
    await fs.writeFile(path.join(dir, "existing.txt"), "keep\n");

    const error = await rejection(
      applyPatch(patch("*** Add File: existing.txt\n+clobber"), { cwd: dir }),
    );

    expect(error.message).not.toContain(PARTIAL);
  });

  it("reports applied hunks on cancellation between writes and stays an abort", async () => {
    const memory = createMemoryPatchSandbox({ "a.txt": "one\n", "b.txt": "one\n" });
    const controller = new AbortController();
    memory.writeFile.mockImplementationOnce(async ({ filePath, data }) => {
      memory.files.set(filePath, data);
      controller.abort();
    });

    const error = await rejection(
      createApplyPatchTool({ ...memory.options, abortSignal: controller.signal }).execute(
        "partial",
        { input: patch(update("a.txt", "one", "two"), update("b.txt", "one", "two")) },
      ),
    );

    expect(error.name).toBe("AbortError");
    expect(error.message).toContain(`${PARTIAL}\nM a.txt\n`);
    expect(Object.fromEntries(memory.files)).toEqual({
      "/sandbox/a.txt": "two\n",
      "/sandbox/b.txt": "one\n",
    });
  });

  it("reports a move whose source removal failed as an added copy", async () => {
    const memory = createMemoryPatchSandbox({ "old.txt": "one\n" });
    memory.remove.mockRejectedValueOnce(new Error("Permission denied removing old.txt"));

    const error = await rejection(
      applyPatch(
        patch("*** Update File: old.txt\n*** Move to: new.txt\n@@\n-one\n+two"),
        memory.options,
      ),
    );

    expect(error.message).toContain(`Permission denied removing old.txt\n${PARTIAL}\nA new.txt\n`);
    expect(Object.fromEntries(memory.files)).toEqual({
      "/sandbox/old.txt": "one\n",
      "/sandbox/new.txt": "two\n",
    });
  });
});
