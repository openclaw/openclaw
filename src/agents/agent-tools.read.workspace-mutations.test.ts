import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { hostFileTools } from "./agent-tools.mutation.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("workspace mutations", () => {
  afterEach(() => __setFsSafeTestHooksForTest());

  it("preserves a workspace file when cancelled during native write preparation", async () => {
    const root = tempDirs.make("openclaw-workspace-cancelled-");
    const filePath = path.join(root, "memory.md");
    await fs.writeFile(filePath, "original\n");
    const canonicalPath = await fs.realpath(filePath);
    const controller = new AbortController();
    const cancelled = new Error("Workspace write cancelled");
    __setFsSafeTestHooksForTest({
      beforePinnedWriteParentAdmission: async (targetPath) => {
        if (targetPath === canonicalPath) {
          controller.abort(cancelled);
        }
      },
    });
    const { write } = hostFileTools(root, {
      workspaceOnly: true,
      abortSignal: controller.signal,
    });
    await expect(write("memory.md", "replacement\n")).rejects.toThrow(cancelled.message);
    expect(await fs.readFile(filePath, "utf8")).toBe("original\n");
  });

  it("creates a missing workspace and writes and edits inside its literal tilde directory", async () => {
    const fixture = tempDirs.make("openclaw-workspace-tilde-");
    const root = path.join(fixture, "workspace");
    const filePath = path.join(root, "~", "file.txt");
    const options = { workspaceOnly: true };

    const tools = hostFileTools(root, options);
    await tools.write(filePath, "original");
    await tools.edit(filePath, "original", "replacement");

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("replacement");
  });

  it.runIf(process.platform !== "win32")(
    "writes through a directory symlink whose target is the workspace root",
    async () => {
      const root = tempDirs.make("openclaw-workspace-root-link-");
      const alias = path.join(root, "self");
      await fs.symlink(root, alias, "dir");
      await hostFileTools(root, { workspaceOnly: true }).write("self/file.txt", "new");

      await expect(fs.readFile(path.join(root, "file.txt"), "utf8")).resolves.toBe("new");
      expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
    },
  );
});

describe("host file paths", () => {
  it("writes and edits the same OS-home path despite OPENCLAW_HOME", async () => {
    const home = process.env.HOME ?? os.homedir();
    const directory = tempDirs.make("openclaw-host-home-", home);
    const openclawHome = tempDirs.make("openclaw-home-override-");
    const filePath = path.join(directory, "nested", "file.txt");
    const modelPath = path.join("~", path.relative(home, filePath));

    await withEnvAsync({ OPENCLAW_HOME: openclawHome }, async () => {
      const tools = hostFileTools(openclawHome);
      await tools.write(modelPath, "original");
      await tools.edit(modelPath, "original", "replacement");
      expect(await fs.readFile(filePath, "utf8")).toBe("replacement");
      expect(await fs.readdir(openclawHome)).toEqual([]);
    });
  });

  it.runIf(process.platform !== "win32")("reports the workspace escape through edit", async () => {
    const fixture = tempDirs.make("openclaw-edit-escape-");
    const root = path.join(fixture, "workspace");
    const outside = path.join(fixture, "outside");
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.symlink(outside, path.join(root, "escape"));

    await expect(
      hostFileTools(root, { workspaceOnly: true }).edit("escape/secret.txt", "secret", "changed"),
    ).rejects.toThrow("Path escapes workspace root");
    expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret");
  });
});
