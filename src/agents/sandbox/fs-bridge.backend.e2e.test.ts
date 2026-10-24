import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "./remote-fs-bridge.test-helpers.js";

let workspaceDir: string;
let commandCount: number;
const at = (relativePath: string) => path.join(workspaceDir, relativePath);
const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  workspaceDir = dirs.make("openclaw-fsbridge-e2e-");
  commandCount = 0;
});

function createBridge(workspaceAccess: "rw" | "ro" = "rw") {
  return createSandboxFsBridge({
    sandbox: {
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      workspaceAccess,
      containerName: "local-backend-fsbridge",
      containerWorkdir: workspaceDir,
      docker: {},
      backend: {
        runShellCommand: createLocalRemoteShellScriptRunner({
          onCommand: () => commandCount++,
        }),
      },
    },
  });
}

const expectContents = (relativePath: string, contents: string) =>
  expect(fs.readFile(at(relativePath), "utf8")).resolves.toBe(contents);
const expectMissing = (relativePath: string) =>
  expect(fs.stat(at(relativePath))).rejects.toMatchObject({ code: "ENOENT" });

describe.runIf(process.platform !== "win32")("sandbox fs bridge local backend e2e", () => {
  it("rejects read-only workspace writes before running shell commands", async () => {
    await expect(
      createBridge("ro").writeFile({ filePath: "note", data: "blocked" }),
    ).rejects.toThrow("read-only");
    expect(commandCount).toBe(0);
  });

  it.each(["write", "remove", "rename"] as const)("protects skills from %s", async (mutation) => {
    const skillRelativePath =
      mutation === "write" ? "skills/demo/SKILL.md" : ".agents/skills/demo/SKILL.md";
    const skillPath = at(skillRelativePath);
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, "managed instructions");
    const bridge = createBridge();
    const mutate =
      mutation === "write"
        ? bridge.writeFile({ filePath: skillRelativePath, data: "changed" })
        : mutation === "remove"
          ? bridge.remove({ filePath: ".agents", recursive: true })
          : bridge.rename({ from: ".agents", to: "moved-instructions" });
    await expect(mutate).rejects.toThrow("read-only");
    await expect(fs.readFile(skillPath, "utf8")).resolves.toBe("managed instructions");
  });

  it("streams a large file through pinned copy", async () => {
    const destinationPath = at("real/nested/large-copy.bin");
    const largeFileBytes = 64 * 1024 * 1024 + 17;
    {
      await using source = await fs.open(at("large-source.bin"), "w");
      await source.truncate(largeFileBytes);
      await source.write(Buffer.from("head"), 0, 4, 0);
      await source.write(Buffer.from("tail"), 0, 4, largeFileBytes - 4);
    }
    const bridge = createBridge();
    await fs.mkdir(at("real"));
    await fs.symlink(at("real"), at("alias"));
    const target = await bridge.resolvePinnedMutationTarget!({
      filePath: "alias/nested/large-copy.bin",
      action: "copy-destination",
    });
    await bridge.copyFile!({
      sourcePath: "large-source.bin",
      destinationPath: "alias/nested/large-copy.bin",
      pinnedPath: target.pinnedPath,
    });
    await using copied = await fs.open(destinationPath, "r");
    const head = Buffer.alloc(4);
    const tail = Buffer.alloc(4);
    await copied.read(head, 0, 4, 0);
    await copied.read(tail, 0, 4, largeFileBytes - 4);
    expect([head.toString(), tail.toString()]).toEqual(["head", "tail"]);
    await expect(fs.stat(destinationPath)).resolves.toMatchObject({ size: largeFileBytes });
  });

  it("pins alias mutations to their authorized destinations", async () => {
    const bridge = createBridge();
    await fs.mkdir(at("real"));
    await fs.mkdir(at("decoy"));
    await fs.symlink(at("real"), at("alias"));
    const pin = async (filePath: string, action: "write" | "mkdir" | "remove") => ({
      filePath,
      ...(await bridge.resolvePinnedMutationTarget!({ filePath, action })),
    });
    const writeTarget = await pin("alias/note.txt", "write");
    expect(writeTarget.pinnedPath).toBe(at("real/note.txt"));
    expect(writeTarget.policyPath).toBe(at("real/note.txt"));
    await expect(
      bridge.createFileExclusive!({ ...writeTarget, data: "pinned-write" }),
    ).resolves.toBe("created");
    await expectContents("real/note.txt", "pinned-write");
    await expect(bridge.readDirectory!({ filePath: "alias" })).resolves.toEqual([
      { name: "note.txt", isDirectory: false },
    ]);
    await expect(bridge.readDirectory!({ filePath: "../" })).rejects.toThrow();
    await fs.symlink(path.dirname(workspaceDir), at("outside"));
    await expect(bridge.readDirectory!({ filePath: "outside" })).rejects.toThrow();

    // Post-authorization alias swap: the pinned write cannot be redirected.
    await fs.unlink(at("alias"));
    await fs.symlink(at("decoy"), at("alias"));
    await bridge.writeFile({ ...writeTarget, data: "after-swap" });
    await expectContents("real/note.txt", "after-swap");
    await expectMissing("decoy/note.txt");
    await fs.unlink(at("alias"));
    await fs.symlink(at("real"), at("alias"));
    await bridge.mkdirp(await pin("alias/newdir", "mkdir"));
    await bridge.rename({ from: "alias/note.txt", to: "alias/moved.txt" });
    await expectContents("real/moved.txt", "after-swap");
    await bridge.remove({ ...(await pin("alias/moved.txt", "remove")), force: true });
    await expectMissing("real/moved.txt");
    await expect(bridge.readDirectory!({ filePath: "real" })).resolves.toEqual([
      { name: "newdir", isDirectory: true },
    ]);
    await bridge.mkdirp(await pin(".", "mkdir"));
  });
});
