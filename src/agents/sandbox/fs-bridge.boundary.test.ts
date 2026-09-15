import { spawnSync } from "node:child_process";
// Sandbox filesystem bridge boundary tests cover host-side validation before
// any Docker filesystem command can run.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
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

  it("distinguishes large inode values that collide as Numbers", () => {
    // The admission window compares exact bigint identities through the fs-safe
    // owner's comparator: the Number conversion collapses these two distinct
    // inode values into one.
    const largeInodeA = 9007199254740992n;
    const largeInodeB = 9007199254740993n;
    expect(Number(largeInodeA)).toBe(Number(largeInodeB));
    expect(
      sameFileIdentity(
        { dev: 1n, ino: largeInodeA } as fsSync.BigIntStats,
        { dev: 1n, ino: largeInodeB } as fsSync.BigIntStats,
      ),
    ).toBe(false);
  });

  it("matches identical bigint identities", () => {
    expect(
      sameFileIdentity(
        { dev: 1n, ino: 9007199254740992n } as fsSync.BigIntStats,
        { dev: 1n, ino: 9007199254740992n } as fsSync.BigIntStats,
      ),
    ).toBe(true);
  });

  it("never rejects unavailable Windows identities as mismatches", () => {
    const known = { dev: 1n, ino: 9007199254740992n } as fsSync.BigIntStats;
    const unknown = { dev: 0n, ino: 0n } as fsSync.BigIntStats;
    expect(sameFileIdentity(known, unknown, "win32")).toBe(true);
    expect(sameFileIdentity(unknown, known, "win32")).toBe(true);
  });

  it("rejects definite known-value mismatches", () => {
    expect(
      sameFileIdentity(
        { dev: 1n, ino: 9007199254740992n } as fsSync.BigIntStats,
        { dev: 1n, ino: 42n } as fsSync.BigIntStats,
      ),
    ).toBe(false);
  });

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

  it.runIf(process.platform !== "win32")(
    "preserves an explicitly requested mount when host roots overlap",
    async () => {
      await withTempDir("openclaw-fs-policy-overlapping-mounts-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        const nestedDir = path.join(workspaceDir, "sub");
        await fs.mkdir(nestedDir, { recursive: true });
        await fs.writeFile(path.join(nestedDir, "note.txt"), "allowed");
        await fs.symlink(nestedDir, path.join(workspaceDir, "alias"), "dir");
        const bridge = createSandboxFsBridge({
          sandbox: createSandbox({
            workspaceDir,
            agentWorkspaceDir: workspaceDir,
            docker: {
              ...createSandbox().docker,
              binds: [`${nestedDir}:/reference:ro`],
            },
          }),
        });

        await expect(
          resolveSandboxFilePolicyPath({
            bridge,
            filePath: "/workspace/sub/note.txt",
          }),
        ).resolves.toBe("/workspace/sub/note.txt");
        await expect(
          resolveSandboxFilePolicyPath({
            bridge,
            filePath: "/workspace/alias/note.txt",
          }),
        ).resolves.toBe("/reference/note.txt");
      });
    },
  );

  it("admits an allowed read whose resolved identity is stable", async () => {
    await withTempDir("openclaw-fs-admission-control-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      const pubDir = path.join(workspaceDir, "pub");
      await fs.mkdir(pubDir, { recursive: true });
      await fs.writeFile(path.join(pubDir, "note.txt"), "allowed-public");
      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
      });

      const policyPath = await resolveSandboxFilePolicyPath({
        bridge,
        filePath: "/workspace/pub/note.txt",
      });
      expect(policyPath).toBe("/workspace/pub/note.txt");
      await expect(bridge.readFile({ filePath: policyPath })).resolves.toEqual(
        Buffer.from("allowed-public"),
      );
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects a read whose target is replaced between canonical resolution and descriptor admission",
    async () => {
      await withTempDir("openclaw-fs-admission-swap-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        const pubDir = path.join(workspaceDir, "pub");
        const privateDir = path.join(workspaceDir, "private");
        await fs.mkdir(pubDir, { recursive: true });
        await fs.mkdir(privateDir, { recursive: true });
        await fs.writeFile(path.join(pubDir, "note.txt"), "allowed-public");
        await fs.writeFile(path.join(privateDir, "secret.txt"), "denied-secret-content");
        let swapApplied = false;
        const bridge = createSandboxFsBridge({
          sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
          beforeDescriptorAdmission: () => {
            if (swapApplied) {
              return;
            }
            swapApplied = true;
            // Replace the authorized path's object with the denied file after
            // the opener captured the resolution-time identity but before it
            // admitted the descriptor.
            fsSync.renameSync(path.join(privateDir, "secret.txt"), path.join(pubDir, "note.txt"));
          },
        });

        const policyPath = await resolveSandboxFilePolicyPath({
          bridge,
          filePath: "/workspace/pub/note.txt",
        });
        expect(policyPath).toBe("/workspace/pub/note.txt");

        await expect(bridge.readFile({ filePath: policyPath })).rejects.toThrow(
          /identity changed between canonical resolution and descriptor admission/,
        );
        // The denied object really did occupy the authorized path in the
        // window, and no read effect returned any of its bytes.
        expect(swapApplied).toBe(true);
        expect(await fs.readFile(path.join(pubDir, "note.txt"))).toEqual(
          Buffer.from("denied-secret-content"),
        );
      });
    },
  );

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
