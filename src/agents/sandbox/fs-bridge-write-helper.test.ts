import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SANDBOX_PINNED_WRITE_PYTHON } from "./fs-bridge-write-helper.js";

async function withTempRoot<T>(prefix: string, run: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function runPinnedWrite(params: {
  mountRoot: string;
  relativeParentPath: string;
  basename: string;
  mkdir: boolean;
  input: string;
}) {
  return spawnSync(
    "python3",
    [
      "-c",
      SANDBOX_PINNED_WRITE_PYTHON,
      params.mountRoot,
      params.relativeParentPath,
      params.basename,
      params.mkdir ? "1" : "0",
    ],
    {
      input: params.input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

describe("sandbox pinned write helper", () => {
  it("creates missing parents and writes through a pinned directory fd", async () => {
    await withTempRoot("openclaw-write-helper-", async (root) => {
      const workspace = path.join(root, "workspace");
      await fs.mkdir(workspace, { recursive: true });

      const result = runPinnedWrite({
        mountRoot: workspace,
        relativeParentPath: "nested/deeper",
        basename: "note.txt",
        mkdir: true,
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

        const result = runPinnedWrite({
          mountRoot: workspace,
          relativeParentPath: "alias",
          basename: "escape.txt",
          mkdir: false,
          input: "owned",
        });

        expect(result.status).not.toBe(0);
        await expect(fs.readFile(path.join(outside, "escape.txt"), "utf8")).rejects.toThrow();
      });
    },
  );
});
