import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SANDBOX_PINNED_FS_MUTATION_PYTHON } from "./fs-bridge-mutation-helper.js";

async function withTempRoot<T>(prefix: string, run: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function runPinnedMutation(params: {
  op: "write" | "mkdirp" | "remove" | "rename";
  args: string[];
  input?: string;
}) {
  return spawnSync(
    "python3",
    ["-c", SANDBOX_PINNED_FS_MUTATION_PYTHON, params.op, ...params.args],
    {
      input: params.input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

describe("sandbox pinned mutation helper", () => {
  it("creates missing parents and writes through a pinned directory fd", async () => {
    await withTempRoot("openclaw-write-helper-", async (root) => {
      const workspace = path.join(root, "workspace");
      await fs.mkdir(workspace, { recursive: true });

      const result = runPinnedMutation({
        op: "write",
        args: [workspace, "nested/deeper", "note.txt", "1"],
        input: "hello",
      });

      expect(result.status).toBe(0);
      await expect(
        fs.readFile(path.join(workspace, "nested", "deeper", "note.txt"), "utf8"),
      ).resolves.toBe("hello");
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlink-parent writes instead of materializing a temp file outside the mount",
    async () => {
      await withTempRoot("openclaw-write-helper-", async (root) => {
        const workspace = path.join(root, "workspace");
        const outside = path.join(root, "outside");
        await fs.mkdir(workspace, { recursive: true });
        await fs.mkdir(outside, { recursive: true });
        await fs.symlink(outside, path.join(workspace, "alias"));

        const result = runPinnedMutation({
          op: "write",
          args: [workspace, "alias", "escape.txt", "0"],
          input: "owned",
        });

        expect(result.status).not.toBe(0);
        await expect(fs.readFile(path.join(outside, "escape.txt"), "utf8")).rejects.toThrow();
      });
    },
  );
});
