import { spawnSync } from "node:child_process";
// Sandbox filesystem bridge boundary tests cover host-side validation before
// any Docker filesystem command can run.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveSandboxFilePolicyPath } from "./file-mutation-identity.js";
import {
  createHostEscapeFixture,
  createSandbox,
  createSandboxFsBridge,
  expectMkdirpAllowsExistingDirectory,
  findCallByDockerArg,
  installFsBridgeTestHarness,
  mockedExecDockerRaw,
  withTempDir,
} from "./fs-bridge.test-helpers.js";

describe("sandbox fs bridge boundary validation", () => {
  installFsBridgeTestHarness();

  it("blocks writes into read-only bind mounts", async () => {
    const sandbox = createSandbox({
      docker: {
        ...createSandbox().docker,
        binds: ["/tmp/workspace-two:/workspace-two:ro"],
      },
    });
    const bridge = createSandboxFsBridge({ sandbox });

    await expect(
      bridge.writeFile({ filePath: "/workspace-two/new.txt", data: "hello" }),
    ).rejects.toThrow(/read-only/);
    expect(mockedExecDockerRaw).not.toHaveBeenCalled();
  });

  it("allows mkdirp for existing in-boundary subdirectories", async () => {
    await expectMkdirpAllowsExistingDirectory();
  });

  it("allows mkdirp when boundary open reports io for an existing directory", async () => {
    await expectMkdirpAllowsExistingDirectory({ forceBoundaryIoFallback: true });
  });

  it("maps host-backed aliases back to canonical policy paths", async () => {
    await withTempDir("openclaw-fs-policy-alias-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      const privateDir = path.join(workspaceDir, "private");
      await fs.mkdir(privateDir, { recursive: true });
      await fs.writeFile(path.join(privateDir, "secret.txt"), "secret");
      await fs.symlink(privateDir, path.join(workspaceDir, "alias"), "dir");
      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
      });

      await expect(
        resolveSandboxFilePolicyPath({
          bridge,
          filePath: "/workspace/alias/secret.txt",
        }),
      ).resolves.toBe("/workspace/private/secret.txt");
    });
  });

  it("preserves a symlinked mount root while reading through the canonical policy path", async () => {
    await withTempDir("openclaw-fs-policy-root-alias-", async (stateDir) => {
      const realWorkspaceDir = path.join(stateDir, "real-workspace");
      const workspaceDir = path.join(stateDir, "workspace-link");
      await fs.mkdir(realWorkspaceDir, { recursive: true });
      await fs.writeFile(path.join(realWorkspaceDir, "note.txt"), "allowed");
      await fs.symlink(realWorkspaceDir, workspaceDir, "dir");
      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
      });

      const policyPath = await resolveSandboxFilePolicyPath({
        bridge,
        filePath: "/workspace/note.txt",
      });
      expect(policyPath).toBe("/workspace/note.txt");
      await expect(bridge.readFile({ filePath: policyPath })).resolves.toEqual(
        Buffer.from("allowed"),
      );
    });
  });

  it.runIf(process.platform === "win32")(
    "maps differently cased host paths back to canonical policy paths",
    async () => {
      await withTempDir("openclaw-fs-policy-case-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        const privateDir = path.join(workspaceDir, "private");
        await fs.mkdir(privateDir, { recursive: true });
        await fs.writeFile(path.join(privateDir, "secret.txt"), "secret");
        const bridge = createSandboxFsBridge({
          sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
        });

        await expect(
          resolveSandboxFilePolicyPath({
            bridge,
            filePath: "/workspace/PRIVATE/SECRET.txt",
          }),
        ).resolves.toBe("/workspace/private/secret.txt");
      });
    },
  );

  it("rejects mkdirp when target exists as a file", async () => {
    await withTempDir("openclaw-fs-bridge-mkdirp-file-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      const filePath = path.join(workspaceDir, "memory", "kemik");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "not a directory");

      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
      });

      await expect(bridge.mkdirp({ filePath: "memory/kemik" })).rejects.toThrow(
        /cannot create directories/i,
      );
      expect(findCallByDockerArg(1, "mkdirp")).toBeUndefined();
    });
  });

  it.each(["file", "directory"] as const)(
    "rejects pre-existing host %s symlink escapes before docker exec",
    async (kind) => {
      // Host-visible symlink escapes are rejected locally so Docker never follows
      // them inside a privileged bridge command.
      await withTempDir("openclaw-fs-bridge-", async (stateDir) => {
        const { workspaceDir, outsideFile } = await createHostEscapeFixture(stateDir);
        if (process.platform === "win32") {
          return;
        }
        await fs.symlink(
          kind === "directory" ? path.dirname(outsideFile) : outsideFile,
          path.join(workspaceDir, "link.txt"),
        );

        const bridge = createSandboxFsBridge({
          sandbox: createSandbox({
            workspaceDir,
            agentWorkspaceDir: workspaceDir,
          }),
        });

        await expect(
          kind === "directory"
            ? bridge.mkdirp({ filePath: "link.txt" })
            : bridge.readFile({ filePath: "link.txt" }),
        ).rejects.toThrow(/Symlink escapes/);
        expect(mockedExecDockerRaw).not.toHaveBeenCalled();
      });
    },
  );

  it("rejects pre-existing host hardlink escapes before docker exec", async () => {
    // Hardlinks can expose outside files without a symlink marker, so the bridge
    // checks link metadata before reads enter the container.
    if (process.platform === "win32") {
      return;
    }
    await withTempDir("openclaw-fs-bridge-hardlink-", async (stateDir) => {
      const { workspaceDir, outsideFile } = await createHostEscapeFixture(stateDir);
      const hardlinkPath = path.join(workspaceDir, "link.txt");
      try {
        await fs.link(outsideFile, hardlinkPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EXDEV") {
          return;
        }
        throw err;
      }

      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
      });

      await expect(bridge.readFile({ filePath: "link.txt" })).rejects.toThrow(/hardlink|sandbox/i);
      expect(mockedExecDockerRaw).not.toHaveBeenCalled();
    });
  });

  it("rejects missing files before any docker read command runs", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });
    await expect(bridge.readFile({ filePath: "a.txt" })).rejects.toThrow(/ENOENT|no such file/i);
    expect(mockedExecDockerRaw).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")(
    "rejects a regular file replaced by a FIFO at descriptor open",
    async () => {
      await withTempDir("openclaw-fs-bridge-fifo-swap-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        const filePath = path.join(workspaceDir, "live.pipe");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.writeFile(filePath, "regular");
        const bridge = createSandboxFsBridge({
          sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
        });
        const realOpenSync = fsSync.openSync.bind(fsSync);
        const openSync = vi.spyOn(fsSync, "openSync").mockImplementation((target, flags, mode) => {
          if (path.resolve(String(target)) === filePath) {
            if (typeof flags !== "number" || (flags & fsSync.constants.O_NONBLOCK) === 0) {
              throw new Error("sandbox read descriptor open is blocking");
            }
            fsSync.unlinkSync(filePath);
            expect(spawnSync("mkfifo", [filePath]).status).toBe(0);
          }
          return realOpenSync(target, flags, mode);
        });

        try {
          await expect(bridge.readFile({ filePath: "live.pipe" })).rejects.toThrow(
            /boundary checks|cannot read/i,
          );
        } finally {
          openSync.mockRestore();
        }
        expect(mockedExecDockerRaw).not.toHaveBeenCalled();
      });
    },
  );
});
