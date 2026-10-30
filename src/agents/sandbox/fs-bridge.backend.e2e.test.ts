import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "./remote-fs-bridge.test-helpers.js";
import { createSandboxTestContext } from "./test-fixtures.js";

let stateDir: string;
let workspaceDir: string;
let commandCount: number;
beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fsbridge-e2e-"));
  const workspacePath = path.join(stateDir, "workspace");
  await fs.mkdir(workspacePath);
  workspaceDir = await fs.realpath(workspacePath);
  commandCount = 0;
});
afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

function createBridge(workspaceAccess: "rw" | "ro" | "none" = "rw") {
  const backend: SandboxBackendHandle = {
    id: "local-test",
    runtimeId: "local-backend-fsbridge",
    runtimeLabel: "local-backend-fsbridge",
    workdir: workspaceDir,
    buildExecSpec: async ({ command, env }) => ({
      argv: ["sh", "-c", command],
      env,
      stdinMode: "pipe-closed",
    }),
    runShellCommand: createLocalRemoteShellScriptRunner({
      onCommand: () => commandCount++,
    }),
  };
  const sandbox = createSandboxTestContext({
    overrides: {
      workspaceDir,
      agentWorkspaceDir: workspaceAccess === "none" ? path.join(stateDir, "agent") : workspaceDir,
      workspaceAccess,
      containerName: backend.runtimeId,
      containerWorkdir: workspaceDir,
      backend,
    },
  });
  return createSandboxFsBridge({ sandbox: { ...sandbox, backend } });
}

async function expectContents(relativePath: string, contents: string) {
  await expect(fs.readFile(path.join(workspaceDir, relativePath), "utf8")).resolves.toBe(contents);
}
async function expectMissing(relativePath: string) {
  await expect(fs.stat(path.join(workspaceDir, relativePath))).rejects.toMatchObject({
    code: "ENOENT",
  });
}

describe.runIf(process.platform !== "win32")("sandbox fs bridge local backend e2e", () => {
  it.each([
    { workspaceAccess: "rw", mutation: "write" },
    { workspaceAccess: "none", mutation: "write" },
    { workspaceAccess: "ro", mutation: "write" },
    { workspaceAccess: "rw", mutation: "remove" },
    { workspaceAccess: "rw", mutation: "rename" },
  ] as const)(
    "enforces $workspaceAccess workspace writes and protects skills from $mutation",
    async ({ workspaceAccess, mutation }) => {
      const skillRelativePath =
        mutation === "write" ? "skills/demo/SKILL.md" : ".agents/skills/demo/SKILL.md";
      const skillPath = path.join(workspaceDir, skillRelativePath);
      await fs.mkdir(path.dirname(skillPath), { recursive: true });
      await fs.writeFile(skillPath, "managed instructions");
      const bridge = createBridge(workspaceAccess);
      await expect(bridge.readDirectory!({ filePath: "." })).resolves.toEqual([
        { name: mutation === "write" ? "skills" : ".agents", isDirectory: true },
      ]);
      await expect(bridge.readDirectory!({ filePath: "../" })).rejects.toThrow();
      await fs.symlink(path.dirname(skillPath), path.join(workspaceDir, "alias"));
      await expect(bridge.readDirectory!({ filePath: "alias" })).resolves.toEqual([
        { name: "SKILL.md", isDirectory: false },
      ]);
      await fs.symlink(stateDir, path.join(workspaceDir, "outside"));
      await expect(bridge.readDirectory!({ filePath: "outside" })).rejects.toThrow();
      const commandsBeforeMutation = commandCount;
      if (workspaceAccess === "ro") {
        await expect(
          bridge.writeFile({ filePath: "nested/hello.txt", data: "blocked" }),
        ).rejects.toThrow("read-only");
        expect(commandCount).toBe(commandsBeforeMutation);
        return;
      }
      await bridge.writeFile({ filePath: "nested/hello.txt", data: "from-backend" });

      await expectContents("nested/hello.txt", "from-backend");
      await bridge.rename({ from: "nested", to: "renamed" });
      await expectContents("renamed/hello.txt", "from-backend");
      await bridge.remove({ filePath: "renamed", recursive: true });
      await expectMissing("renamed");
      const mutate =
        mutation === "write"
          ? bridge.writeFile({ filePath: skillRelativePath, data: "changed" })
          : mutation === "remove"
            ? bridge.remove({ filePath: ".agents", recursive: true })
            : bridge.rename({ from: ".agents", to: "moved-instructions" });
      await expect(mutate).rejects.toThrow("read-only");
      await expect(fs.readFile(skillPath, "utf8")).resolves.toBe("managed instructions");
    },
  );

  it("streams a large file through pinned copy", async () => {
    const destinationPath = path.join(workspaceDir, "real/nested/large-copy.bin");
    const largeFileBytes = 64 * 1024 * 1024 + 17;
    {
      await using source = await fs.open(path.join(workspaceDir, "large-source.bin"), "w");
      await source.truncate(largeFileBytes);
      await source.write(Buffer.from("head"), 0, 4, 0);
      await source.write(Buffer.from("tail"), 0, 4, largeFileBytes - 4);
    }
    const bridge = createBridge();
    await fs.mkdir(path.join(workspaceDir, "real"));
    await fs.symlink(path.join(workspaceDir, "real"), path.join(workspaceDir, "alias"));
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
    const realDir = path.join(workspaceDir, "real");
    const decoyDir = path.join(workspaceDir, "decoy");
    await fs.mkdir(realDir);
    await fs.mkdir(decoyDir);
    await fs.symlink(realDir, path.join(workspaceDir, "alias"));
    const pin = async (filePath: string, action: "write" | "mkdir" | "remove") => ({
      filePath,
      ...(await bridge.resolvePinnedMutationTarget!({ filePath, action })),
    });
    const writeTarget = await bridge.resolvePinnedMutationTarget!({
      filePath: "alias/note.txt",
      action: "write",
    });
    expect(writeTarget).toEqual({
      pinnedPath: path.join(realDir, "note.txt"),
      policyPath: path.join(realDir, "note.txt"),
    });
    await expect(
      bridge.createFileExclusive!({
        filePath: "alias/note.txt",
        data: "pinned-write",
        pinnedPath: writeTarget.pinnedPath,
      }),
    ).resolves.toBe("created");
    await expectContents("real/note.txt", "pinned-write");

    // Post-authorization alias swap: the pinned write cannot be redirected.
    await fs.unlink(path.join(workspaceDir, "alias"));
    await fs.symlink(decoyDir, path.join(workspaceDir, "alias"));
    await bridge.writeFile({
      filePath: "alias/note.txt",
      data: "after-swap",
      pinnedPath: writeTarget.pinnedPath,
    });
    await expectContents("real/note.txt", "after-swap");
    await expectMissing("decoy/note.txt");
    await fs.unlink(path.join(workspaceDir, "alias"));
    await fs.symlink(realDir, path.join(workspaceDir, "alias"));
    const mkdirTarget = await pin("alias/newdir", "mkdir");
    expect(mkdirTarget.pinnedPath).toBe(path.join(realDir, "newdir"));
    await bridge.mkdirp(mkdirTarget);
    expect((await fs.stat(path.join(realDir, "newdir"))).isDirectory()).toBe(true);
    await fs.writeFile(path.join(realDir, "gone.txt"), "remove-me");
    await fs.writeFile(path.join(realDir, "keep.txt"), "keep-me");
    await bridge.remove({ ...(await pin("alias/gone.txt", "remove")), force: true });
    await expectMissing("real/gone.txt");
    await expectContents("real/keep.txt", "keep-me");
    await bridge.mkdirp(await pin(".", "mkdir"));
  });
});
