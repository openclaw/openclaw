import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  SandboxBackendHandle,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
} from "./backend-handle.types.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import { createSandboxTestContext } from "./test-fixtures.js";

let stateDir: string;
let workspaceDir: string;
let scripts: string[];
beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fsbridge-e2e-"));
  const workspacePath = path.join(stateDir, "workspace");
  await fs.mkdir(workspacePath);
  workspaceDir = await fs.realpath(workspacePath);
  scripts = [];
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
    runShellCommand: async (params) => {
      scripts.push(params.script);
      return runLocalShellCommand(params);
    },
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

async function runLocalShellCommand(
  params: SandboxBackendCommandParams,
): Promise<SandboxBackendCommandResult> {
  // This backend shim executes the exact shell script the fs bridge emits, so
  // failures prove the generated POSIX script rather than a mocked Docker call.
  return await new Promise<SandboxBackendCommandResult>((resolve, reject) => {
    const child = spawn(
      "sh",
      ["-c", params.script, "openclaw-sandbox-fs", ...(params.args ?? [])],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let aborted = false;

    const onAbort = () => {
      if (aborted) {
        return;
      }
      aborted = true;
      child.kill("SIGTERM");
    };
    params.signal?.addEventListener("abort", onAbort);

    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on("error", reject);
    child.on("close", (code) => {
      params.signal?.removeEventListener("abort", onAbort);
      if (aborted || params.signal?.aborted) {
        reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        return;
      }

      const result = {
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        code: code ?? 0,
      };
      if (result.code !== 0 && !params.allowFailure) {
        reject(new Error(result.stderr.toString("utf8").trim() || `shell exited ${result.code}`));
        return;
      }
      resolve(result);
    });

    child.stdin?.end(params.stdin);
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
      if (!bridge.readDirectory) {
        throw new Error("The mounted bridge must support directory discovery.");
      }
      await expect(bridge.readDirectory({ filePath: "." })).resolves.toEqual([
        { name: mutation === "write" ? "skills" : ".agents", isDirectory: true },
      ]);
      await expect(bridge.readDirectory({ filePath: "../" })).rejects.toThrow();
      await fs.symlink(path.dirname(skillPath), path.join(workspaceDir, "alias"));
      await expect(bridge.readDirectory({ filePath: "alias" })).resolves.toEqual([
        { name: "SKILL.md", isDirectory: false },
      ]);
      await fs.symlink(stateDir, path.join(workspaceDir, "outside"));
      await expect(bridge.readDirectory({ filePath: "outside" })).rejects.toThrow();
      const scriptsBeforeMutation = scripts.length;
      if (workspaceAccess === "ro") {
        await expect(
          bridge.writeFile({ filePath: "nested/hello.txt", data: "blocked" }),
        ).rejects.toThrow("read-only");
        expect(scripts).toHaveLength(scriptsBeforeMutation);
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
      expect(scripts.some((script) => script.includes("operation = sys.argv[1]"))).toBe(true);
    },
  );

  it("streams a large file through pinned copy", async () => {
    const sourcePath = path.join(workspaceDir, "large-source.bin");
    const destinationPath = path.join(workspaceDir, "nested", "large-copy.bin");
    const largeFileBytes = 64 * 1024 * 1024 + 17;
    const source = await fs.open(sourcePath, "w");
    try {
      await source.truncate(largeFileBytes);
      await source.write(Buffer.from("head"), 0, 4, 0);
      await source.write(Buffer.from("tail"), 0, 4, largeFileBytes - 4);
    } finally {
      await source.close();
    }
    const bridge = createBridge();
    const copyFile = bridge.copyFile?.bind(bridge);
    expect(copyFile).toBeTypeOf("function");
    await copyFile!({
      sourcePath: "large-source.bin",
      destinationPath: "nested/large-copy.bin",
    });

    const copied = await fs.open(destinationPath, "r");
    try {
      const head = Buffer.alloc(4);
      const tail = Buffer.alloc(4);
      await copied.read(head, 0, 4, 0);
      await copied.read(tail, 0, 4, largeFileBytes - 4);
      expect(head.toString()).toBe("head");
      expect(tail.toString()).toBe("tail");
    } finally {
      await copied.close();
    }
    await expect(fs.stat(destinationPath)).resolves.toMatchObject({ size: largeFileBytes });
  });

  it("pins alias mutations to their authorized destinations", async () => {
    const bridge = createBridge();
    const realDir = path.join(workspaceDir, "real");
    const decoyDir = path.join(workspaceDir, "decoy");
    await fs.mkdir(realDir);
    await fs.mkdir(decoyDir);
    await fs.symlink(realDir, path.join(workspaceDir, "alias"));
    await fs.writeFile(path.join(workspaceDir, "source.txt"), "copy-source");
    const writeTarget = await bridge.resolvePinnedMutationTarget!({
      filePath: "alias/note.txt",
      action: "write",
    });
    expect(writeTarget.pinnedPath).toBe(path.join(realDir, "note.txt"));
    expect(writeTarget.policyPath).toBe(path.join(realDir, "note.txt"));
    await bridge.writeFile({
      filePath: "alias/note.txt",
      data: "pinned-write",
      pinnedPath: writeTarget.pinnedPath,
    });
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
    const copyTarget = await bridge.resolvePinnedMutationTarget!({
      filePath: "alias/config.txt",
      action: "copy-destination",
    });
    const copyFile = bridge.copyFile?.bind(bridge);
    if (!copyFile) {
      throw new Error("The mounted bridge must support streaming copies.");
    }
    await copyFile({
      sourcePath: "source.txt",
      destinationPath: "alias/config.txt",
      mkdir: true,
      pinnedPath: copyTarget.pinnedPath,
    });
    await expectContents("real/config.txt", "copy-source");
    const mkdirTarget = await bridge.resolvePinnedMutationTarget!({
      filePath: "alias/newdir",
      action: "mkdir",
    });
    expect(mkdirTarget.pinnedPath).toBe(path.join(realDir, "newdir"));
    await bridge.mkdirp({ filePath: "alias/newdir", pinnedPath: mkdirTarget.pinnedPath });
    expect((await fs.stat(path.join(realDir, "newdir"))).isDirectory()).toBe(true);
    await fs.writeFile(path.join(realDir, "gone.txt"), "remove-me");
    await fs.writeFile(path.join(realDir, "keep.txt"), "keep-me");
    const removeTarget = await bridge.resolvePinnedMutationTarget!({
      filePath: "alias/gone.txt",
      action: "remove",
    });
    await bridge.remove({
      filePath: "alias/gone.txt",
      force: true,
      pinnedPath: removeTarget.pinnedPath,
    });
    await expectMissing("real/gone.txt");
    await expectContents("real/keep.txt", "keep-me");
    const rootTarget = await bridge.resolvePinnedMutationTarget!({
      filePath: ".",
      action: "mkdir",
    });
    await bridge.mkdirp({ filePath: ".", pinnedPath: rootTarget.pinnedPath });
  });
});
