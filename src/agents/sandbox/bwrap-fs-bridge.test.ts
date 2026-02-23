import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bwrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bwrap.js")>();
  return {
    ...actual,
    execBwrapRaw: vi.fn(),
    buildBwrapFsBridgeArgs: actual.buildBwrapFsBridgeArgs,
    parseBwrapBind: actual.parseBwrapBind,
  };
});

vi.mock("../../infra/boundary-file-read.js", () => ({
  openBoundaryFile: vi.fn(),
}));

import { openBoundaryFile, type BoundaryFileOpenResult } from "../../infra/boundary-file-read.js";
import { createBwrapFsBridge } from "./bwrap-fs-bridge.js";
import { execBwrapRaw } from "./bwrap.js";
import { createSandboxTestContext } from "./test-fixtures.js";
import type { SandboxBwrapConfig } from "./types.bwrap.js";
import type { SandboxContext } from "./types.js";

const mockedExecBwrapRaw = vi.mocked(execBwrapRaw);
const mockedOpenBoundaryFile = vi.mocked(openBoundaryFile);

const DEFAULT_BWRAP_CFG: SandboxBwrapConfig = {
  workdir: "/workspace",
  readOnlyRoot: true,
  tmpfs: ["/tmp"],
  unshareNet: true,
  unsharePid: true,
  unshareIpc: true,
  unshareCgroup: false,
  newSession: true,
  dieWithParent: true,
  mountProc: true,
};

function createBwrapSandbox(overrides?: Partial<SandboxContext>): SandboxContext {
  return createSandboxTestContext({
    overrides: {
      backend: "bwrap",
      containerName: "",
      bwrap: DEFAULT_BWRAP_CFG,
      ...overrides,
    },
  });
}

describe("bwrap fs-bridge", () => {
  beforeEach(() => {
    mockedExecBwrapRaw.mockReset();
    mockedOpenBoundaryFile.mockReset();
    vi.spyOn(fs, "closeSync").mockImplementation(() => {});
  });

  const BOUNDARY_OK = { ok: true, fd: 999 } as BoundaryFileOpenResult;
  const BOUNDARY_MISSING = { ok: false, reason: "path" } as BoundaryFileOpenResult;

  /**
   * Set up mocks so assertPathSafety passes:
   *  - openBoundaryFile returns ok with a fake fd
   *  - the second execBwrapRaw call (canonical path resolution) returns the
   *    same container path so it stays in-bounds
   */
  function mockPathSafetyPass(containerPath: string) {
    // openBoundaryFile succeeds
    mockedOpenBoundaryFile.mockResolvedValue(BOUNDARY_OK);
    // Canonical path resolution call returns the path unchanged
    mockedExecBwrapRaw.mockImplementation(async (args) => {
      // The canonical-resolution script contains "readlink -f"
      const joined = args.join(" ");
      if (joined.includes("readlink")) {
        return {
          stdout: Buffer.from(containerPath + "\n"),
          stderr: Buffer.alloc(0),
          code: 0,
        };
      }
      // Default: return empty success
      return { stdout: Buffer.from("file contents"), stderr: Buffer.alloc(0), code: 0 };
    });
  }

  describe("readFile", () => {
    it("reads a file via bwrap cat", async () => {
      mockPathSafetyPass("/workspace/test.txt");

      const sandbox = createBwrapSandbox();
      const bridge = createBwrapFsBridge({ sandbox, bwrapCfg: DEFAULT_BWRAP_CFG });
      const result = await bridge.readFile({ filePath: "/workspace/test.txt" });

      expect(result.toString("utf8")).toBe("file contents");
      // Two calls: one for cat, one for canonical resolution
      expect(mockedExecBwrapRaw).toHaveBeenCalled();

      // Find the cat call
      const catCall = mockedExecBwrapRaw.mock.calls.find(([args]) =>
        args.join(" ").includes('cat -- "$1"'),
      );
      expect(catCall).toBeDefined();
    });
  });

  describe("writeFile", () => {
    it("writes a file via bwrap stdin pipe", async () => {
      mockPathSafetyPass("/workspace/output.txt");

      const sandbox = createBwrapSandbox({ workspaceAccess: "rw" });
      const bridge = createBwrapFsBridge({ sandbox, bwrapCfg: DEFAULT_BWRAP_CFG });
      await bridge.writeFile({
        filePath: "/workspace/output.txt",
        data: "hello world",
      });

      expect(mockedExecBwrapRaw).toHaveBeenCalled();
      // Find the write call (the one with stdin input)
      const writeCall = mockedExecBwrapRaw.mock.calls.find(
        ([_args, opts]) => opts && Buffer.isBuffer(opts.input),
      );
      expect(writeCall).toBeDefined();
      expect(writeCall![1]!.input!.toString("utf8")).toBe("hello world");
    });

    it("rejects writes when workspaceAccess is ro", async () => {
      const sandbox = createBwrapSandbox({ workspaceAccess: "ro" });
      const bridge = createBwrapFsBridge({ sandbox, bwrapCfg: DEFAULT_BWRAP_CFG });

      await expect(
        bridge.writeFile({ filePath: "/workspace/test.txt", data: "x" }),
      ).rejects.toThrow(/read-only/);
    });
  });

  describe("stat", () => {
    it("parses stat output for a regular file", async () => {
      mockedOpenBoundaryFile.mockResolvedValue(BOUNDARY_OK);
      mockedExecBwrapRaw.mockImplementation(async (args) => {
        const joined = args.join(" ");
        if (joined.includes("readlink")) {
          return {
            stdout: Buffer.from("/workspace/file.ts\n"),
            stderr: Buffer.alloc(0),
            code: 0,
          };
        }
        return {
          stdout: Buffer.from("regular file|1234|1700000000"),
          stderr: Buffer.alloc(0),
          code: 0,
        };
      });

      const sandbox = createBwrapSandbox();
      const bridge = createBwrapFsBridge({ sandbox, bwrapCfg: DEFAULT_BWRAP_CFG });
      const result = await bridge.stat({ filePath: "/workspace/file.ts" });

      expect(result).toEqual({
        type: "file",
        size: 1234,
        mtimeMs: 1700000000000,
      });
    });

    it("returns null for non-existent file", async () => {
      mockedOpenBoundaryFile.mockResolvedValue(BOUNDARY_MISSING);
      mockedExecBwrapRaw.mockImplementation(async (args) => {
        const joined = args.join(" ");
        if (joined.includes("readlink")) {
          return {
            stdout: Buffer.from("/workspace/nope\n"),
            stderr: Buffer.alloc(0),
            code: 0,
          };
        }
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("stat: cannot stat '/workspace/nope': No such file or directory"),
          code: 1,
        };
      });

      const sandbox = createBwrapSandbox();
      const bridge = createBwrapFsBridge({ sandbox, bwrapCfg: DEFAULT_BWRAP_CFG });
      const result = await bridge.stat({ filePath: "/workspace/nope" });

      expect(result).toBeNull();
    });

    it("parses directory stat output", async () => {
      mockedOpenBoundaryFile.mockResolvedValue(BOUNDARY_OK);
      mockedExecBwrapRaw.mockImplementation(async (args) => {
        const joined = args.join(" ");
        if (joined.includes("readlink")) {
          return {
            stdout: Buffer.from("/workspace/src\n"),
            stderr: Buffer.alloc(0),
            code: 0,
          };
        }
        return {
          stdout: Buffer.from("directory|4096|1700000000"),
          stderr: Buffer.alloc(0),
          code: 0,
        };
      });

      const sandbox = createBwrapSandbox();
      const bridge = createBwrapFsBridge({ sandbox, bwrapCfg: DEFAULT_BWRAP_CFG });
      const result = await bridge.stat({ filePath: "/workspace/src" });

      expect(result).toEqual({
        type: "directory",
        size: 4096,
        mtimeMs: 1700000000000,
      });
    });
  });

  describe("mkdirp", () => {
    it("creates directories via bwrap mkdir", async () => {
      mockPathSafetyPass("/workspace/a/b/c");

      const sandbox = createBwrapSandbox({ workspaceAccess: "rw" });
      const bridge = createBwrapFsBridge({ sandbox, bwrapCfg: DEFAULT_BWRAP_CFG });
      await bridge.mkdirp({ filePath: "/workspace/a/b/c" });

      expect(mockedExecBwrapRaw).toHaveBeenCalled();
      const mkdirCall = mockedExecBwrapRaw.mock.calls.find(([args]) =>
        args.join(" ").includes('mkdir -p -- "$1"'),
      );
      expect(mkdirCall).toBeDefined();
    });
  });

  describe("remove", () => {
    it("removes files via bwrap rm", async () => {
      mockPathSafetyPass("/workspace/old.txt");

      const sandbox = createBwrapSandbox({ workspaceAccess: "rw" });
      const bridge = createBwrapFsBridge({ sandbox, bwrapCfg: DEFAULT_BWRAP_CFG });
      await bridge.remove({ filePath: "/workspace/old.txt" });

      expect(mockedExecBwrapRaw).toHaveBeenCalled();
      const rmCall = mockedExecBwrapRaw.mock.calls.find(([args]) => args.join(" ").includes("rm"));
      expect(rmCall).toBeDefined();
    });

    it("uses recursive flag when specified", async () => {
      mockPathSafetyPass("/workspace/dir");

      const sandbox = createBwrapSandbox({ workspaceAccess: "rw" });
      const bridge = createBwrapFsBridge({ sandbox, bwrapCfg: DEFAULT_BWRAP_CFG });
      await bridge.remove({ filePath: "/workspace/dir", recursive: true });

      const rmCall = mockedExecBwrapRaw.mock.calls.find(([args]) =>
        args.join(" ").includes("rm -f -r"),
      );
      expect(rmCall).toBeDefined();
    });
  });

  describe("rename", () => {
    it("moves files via bwrap mv", async () => {
      mockedOpenBoundaryFile.mockResolvedValue(BOUNDARY_OK);
      let callCount = 0;
      mockedExecBwrapRaw.mockImplementation(async (args) => {
        const joined = args.join(" ");
        if (joined.includes("readlink")) {
          callCount++;
          // First canonical call is for "from", second for "to"
          const path = callCount === 1 ? "/workspace/a.txt" : "/workspace/b.txt";
          return { stdout: Buffer.from(path + "\n"), stderr: Buffer.alloc(0), code: 0 };
        }
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
      });

      const sandbox = createBwrapSandbox({ workspaceAccess: "rw" });
      const bridge = createBwrapFsBridge({ sandbox, bwrapCfg: DEFAULT_BWRAP_CFG });
      await bridge.rename({ from: "/workspace/a.txt", to: "/workspace/b.txt" });

      expect(mockedExecBwrapRaw).toHaveBeenCalled();
      const mvCall = mockedExecBwrapRaw.mock.calls.find(([a]) =>
        a.join(" ").includes('mv -- "$1" "$2"'),
      );
      expect(mvCall).toBeDefined();
    });
  });

  describe("assertPathSafety", () => {
    it("rejects read when canonical path escapes mount", async () => {
      // openBoundaryFile succeeds (host-side ok)
      mockedOpenBoundaryFile.mockResolvedValue(BOUNDARY_OK);
      // Canonical resolution returns an out-of-mount path (like /etc/passwd)
      mockedExecBwrapRaw.mockImplementation(async (args) => {
        const joined = args.join(" ");
        if (joined.includes("readlink")) {
          return {
            stdout: Buffer.from("/etc/passwd\n"),
            stderr: Buffer.alloc(0),
            code: 0,
          };
        }
        return { stdout: Buffer.from("root:x:0:0:root"), stderr: Buffer.alloc(0), code: 0 };
      });

      const sandbox = createBwrapSandbox();
      const bridge = createBwrapFsBridge({ sandbox, bwrapCfg: DEFAULT_BWRAP_CFG });

      await expect(bridge.readFile({ filePath: "/workspace/evil-link" })).rejects.toThrow(
        /escapes allowed mounts/,
      );
    });

    it("rejects read when host boundary file check fails", async () => {
      mockedOpenBoundaryFile.mockResolvedValue({
        ok: false,
        reason: "validation",
        error: new Error("Symlink escape detected"),
      } as BoundaryFileOpenResult);

      const sandbox = createBwrapSandbox();
      const bridge = createBwrapFsBridge({ sandbox, bwrapCfg: DEFAULT_BWRAP_CFG });

      await expect(bridge.readFile({ filePath: "/workspace/sneaky" })).rejects.toThrow(
        /Symlink escape detected/,
      );
    });
  });

  describe("extraBinds in mount map", () => {
    it("resolves paths under extraBinds", async () => {
      const cfgWithExtra: SandboxBwrapConfig = {
        ...DEFAULT_BWRAP_CFG,
        extraBinds: ["/host-data:/container-data:rw"],
      };
      mockPathSafetyPass("/container-data/file.txt");

      const sandbox = createBwrapSandbox();
      const bridge = createBwrapFsBridge({ sandbox, bwrapCfg: cfgWithExtra });
      const resolved = bridge.resolvePath({ filePath: "/container-data/file.txt" });
      expect(resolved.containerPath).toBe("/container-data/file.txt");
      expect(resolved.hostPath).toContain("/host-data");
    });

    it("reads files from extraBinds paths", async () => {
      const cfgWithExtra: SandboxBwrapConfig = {
        ...DEFAULT_BWRAP_CFG,
        extraBinds: ["/host-data:/container-data:rw"],
      };

      mockedOpenBoundaryFile.mockResolvedValue(BOUNDARY_OK);
      mockedExecBwrapRaw.mockImplementation(async (args) => {
        const joined = args.join(" ");
        if (joined.includes("readlink")) {
          return {
            stdout: Buffer.from("/container-data/file.txt\n"),
            stderr: Buffer.alloc(0),
            code: 0,
          };
        }
        return { stdout: Buffer.from("extra data"), stderr: Buffer.alloc(0), code: 0 };
      });

      const sandbox = createBwrapSandbox();
      const bridge = createBwrapFsBridge({ sandbox, bwrapCfg: cfgWithExtra });
      const result = await bridge.readFile({ filePath: "/container-data/file.txt" });
      expect(result.toString("utf8")).toBe("extra data");
    });
  });
});
