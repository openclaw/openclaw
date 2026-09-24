import { spawnSync } from "node:child_process";
// Sandbox filesystem bridge boundary tests cover host validation before content
// reads or mutations; container metadata resolves mount-aware aliases first.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createHostEscapeFixture,
  createSandbox,
  expectOnlyCanonicalPathCommands,
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
    "rejects pre-existing host %s symlink escapes before content access",
    async (kind) => {
      // Host-visible escapes must fail before content access. Read metadata may
      // resolve container aliases; mkdir keeps its original host-first check.
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
        if (kind === "directory") {
          expect(mockedExecDockerRaw).not.toHaveBeenCalled();
        } else {
          expectOnlyCanonicalPathCommands();
        }
      });
    },
  );

  it("rejects pre-existing host hardlink escapes before content access", async () => {
    // Hardlinks can expose outside files without a symlink marker, so the bridge
    // checks link metadata before any file contents are read.
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
      expectOnlyCanonicalPathCommands();
    });
  });

  it("rejects missing files without a container content-read command", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });
    await expect(bridge.readFile({ filePath: "a.txt" })).rejects.toThrow(/ENOENT|no such file/i);
    expectOnlyCanonicalPathCommands();
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
        expectOnlyCanonicalPathCommands();
      });
    },
  );
});
