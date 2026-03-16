import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  buildPinnedWritePlan,
  SANDBOX_PINNED_MUTATION_PYTHON,
} from "./fs-bridge-mutation-helper.js";

function runMutation(args: string[], input?: string) {
  return spawnSync("python3", ["-c", SANDBOX_PINNED_MUTATION_PYTHON, ...args], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function runWritePlan(args: string[], input?: string) {
  const plan = buildPinnedWritePlan({
    check: {
      target: {
        hostPath: args[1] ?? "",
        containerPath: args[1] ?? "",
        relativePath: path.posix.join(args[2] ?? "", args[3] ?? ""),
        writable: true,
      },
      options: {
        action: "write files",
        requireWritable: true,
      },
    },
    pinned: {
      mountRootPath: args[1] ?? "",
      relativeParentPath: args[2] ?? "",
      basename: args[3] ?? "",
    },
    mkdir: args[4] === "1",
  });

  return spawnSync("sh", ["-c", plan.script, "moltbot-sandbox-fs", ...(plan.args ?? [])], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("sandbox pinned mutation helper", () => {
  it("writes through a pinned directory fd", async () => {
    await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
      const workspace = path.join(root, "workspace");
      await fs.mkdir(workspace, { recursive: true });

      const result = runMutation(["write", workspace, "nested/deeper", "note.txt", "1"], "hello");

      expect(result.status).toBe(0);
      await expect(
        fs.readFile(path.join(workspace, "nested", "deeper", "note.txt"), "utf8"),
      ).resolves.toBe("hello");
    });
  });

  it.runIf(process.platform !== "win32")(
    "preserves stdin payload bytes when the pinned write plan runs through sh",
    async () => {
      await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
        const workspace = path.join(root, "workspace");
        await fs.mkdir(workspace, { recursive: true });

        const result = runWritePlan(
          ["write", workspace, "nested/deeper", "note.txt", "1"],
          "hello",
        );

        expect(result.status).toBe(0);
        await expect(
          fs.readFile(path.join(workspace, "nested", "deeper", "note.txt"), "utf8"),
        ).resolves.toBe("hello");
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlink-parent writes instead of materializing a temp file outside the mount",
    async () => {
      await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
        const workspace = path.join(root, "workspace");
        const outside = path.join(root, "outside");
        await fs.mkdir(workspace, { recursive: true });
        await fs.mkdir(outside, { recursive: true });
        await fs.symlink(outside, path.join(workspace, "alias"));

        const result = runMutation(["write", workspace, "alias", "escape.txt", "0"], "owned");

        expect(result.status).not.toBe(0);
        await expect(fs.readFile(path.join(outside, "escape.txt"), "utf8")).rejects.toThrow();
      });
    },
  );

  it.runIf(process.platform !== "win32")("rejects symlink segments during mkdirp", async () => {
    await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
      const workspace = path.join(root, "workspace");
      const outside = path.join(root, "outside");
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      await fs.symlink(outside, path.join(workspace, "alias"));

      const result = runMutation(["mkdirp", workspace, "alias/nested"]);

      expect(result.status).not.toBe(0);
      await expect(fs.readFile(path.join(outside, "nested"), "utf8")).rejects.toThrow();
    });
  });

  it.runIf(process.platform !== "win32")("remove unlinks the symlink itself", async () => {
    await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
      const workspace = path.join(root, "workspace");
      const outside = path.join(root, "outside");
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(path.join(outside, "secret.txt"), "classified", "utf8");
      await fs.symlink(path.join(outside, "secret.txt"), path.join(workspace, "link.txt"));

      const result = runMutation(["remove", workspace, "", "link.txt", "0", "0"]);

      expect(result.status).toBe(0);
      await expect(fs.readlink(path.join(workspace, "link.txt"))).rejects.toThrow();
      await expect(fs.readFile(path.join(outside, "secret.txt"), "utf8")).resolves.toBe(
        "classified",
      );
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlink destination parents during rename",
    async () => {
      await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
        const workspace = path.join(root, "workspace");
        const outside = path.join(root, "outside");
        await fs.mkdir(workspace, { recursive: true });
        await fs.mkdir(outside, { recursive: true });
        await fs.writeFile(path.join(workspace, "from.txt"), "payload", "utf8");
        await fs.symlink(outside, path.join(workspace, "alias"));

        const result = runMutation([
          "rename",
          workspace,
          "",
          "from.txt",
          workspace,
          "alias",
          "escape.txt",
          "1",
        ]);

        expect(result.status).not.toBe(0);
        await expect(fs.readFile(path.join(workspace, "from.txt"), "utf8")).resolves.toBe(
          "payload",
        );
        await expect(fs.readFile(path.join(outside, "escape.txt"), "utf8")).rejects.toThrow();
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "copies directories across different mount roots during rename fallback",
    async () => {
      await withTempDir({ prefix: "openclaw-mutation-helper-" }, async (root) => {
        const sourceRoot = path.join(root, "source");
        const destRoot = path.join(root, "dest");
        await fs.mkdir(path.join(sourceRoot, "dir", "nested"), { recursive: true });
        await fs.mkdir(destRoot, { recursive: true });
        await fs.writeFile(path.join(sourceRoot, "dir", "nested", "file.txt"), "payload", "utf8");

        const result = runMutation(["rename", sourceRoot, "", "dir", destRoot, "", "moved", "1"]);

        expect(result.status).toBe(0);
        await expect(
          fs.readFile(path.join(destRoot, "moved", "nested", "file.txt"), "utf8"),
        ).resolves.toBe("payload");
        await expect(fs.stat(path.join(sourceRoot, "dir"))).rejects.toThrow();
      });
    },
  );
});
