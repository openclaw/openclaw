import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createHostWorkspaceEditTool, createHostWorkspaceWriteTool } from "./agent-tools.read.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("host file paths", () => {
  it("writes and edits the same OS-home path despite OPENCLAW_HOME", async () => {
    const home = process.env.HOME ?? os.homedir();
    const directory = tempDirs.make("openclaw-host-home-", home);
    const openclawHome = tempDirs.make("openclaw-home-override-");
    const filePath = path.join(directory, "nested", "file.txt");
    const modelPath = path.join("~", path.relative(home, filePath));

    await withEnvAsync({ OPENCLAW_HOME: openclawHome }, async () => {
      await createHostWorkspaceWriteTool(openclawHome).execute("write", {
        path: modelPath,
        content: "original",
      });
      await createHostWorkspaceEditTool(openclawHome).execute("edit", {
        path: modelPath,
        edits: [{ oldText: "original", newText: "replacement" }],
      });
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
      createHostWorkspaceEditTool(root, { workspaceOnly: true }).execute("escape", {
        path: "escape/secret.txt",
        edits: [{ oldText: "secret", newText: "changed" }],
      }),
    ).rejects.toThrow("Path escapes workspace root");
    expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret");
  });
});
