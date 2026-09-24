import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { resolveSandboxDockerConfig } from "./config.js";
import { resolveSandboxFileIdentity } from "./file-mutation-identity.js";
import { SandboxFsPathGuard } from "./fs-bridge-path-safety.js";
import {
  createSandbox,
  expectOnlyCanonicalPathCommands,
  createSandboxFsBridge,
  dockerExecResult,
  getDockerArg,
  getDockerScript,
  installFsBridgeTestHarness,
  mockContainerCanonicalPaths,
  mockedExecDockerRaw,
  mockedOpenRootFile,
  withTempDir,
} from "./fs-bridge.test-helpers.js";
import { buildSandboxFsMounts, resolveWritableSandboxBindHostRoots } from "./fs-paths.js";

describe("sandbox effective filesystem mounts", () => {
  installFsBridgeTestHarness();

  it.each(["rw", "ro"] as const)(
    "uses the last global/agent /data bind with %s access",
    async (mode) => {
      await withTempDir("openclaw-effective-mounts-", async (workspaceDir) => {
        for (const name of ["A", "B"]) {
          await fs.mkdir(path.join(workspaceDir, name));
          await fs.writeFile(path.join(workspaceDir, name, "marker"), name);
        }
        const docker = resolveSandboxDockerConfig({
          scope: "agent",
          globalDocker: { binds: [`${workspaceDir}/A:/data:${mode === "rw" ? "ro" : "rw"}`] },
          agentDocker: { binds: [`${workspaceDir}/B:/data/:${mode}`] },
        });
        const sandbox = createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          workspaceAccess: "rw",
          docker,
        });
        const bridge = createSandboxFsBridge({ sandbox });
        expect((await bridge.readFile({ filePath: "/data/marker" })).toString()).toBe("B");
        expect(bridge.resolvePath({ filePath: "/data/marker" }).hostPath).toBe(
          path.join(workspaceDir, "B/marker"),
        );
        expect(
          buildSandboxFsMounts(sandbox).filter((mount) => mount.containerRoot === "/data"),
        ).toHaveLength(1);
        expect(resolveWritableSandboxBindHostRoots(docker.binds)).toEqual(
          mode === "rw" ? [path.join(workspaceDir, "B")] : [],
        );
        if (mode === "ro") {
          await expect(
            bridge.writeFile({ filePath: "/data/marker", data: "changed" }),
          ).rejects.toThrow("read-only");
          expectOnlyCanonicalPathCommands();
        }
        expect(await fs.readFile(path.join(workspaceDir, "A/marker"), "utf8")).toBe("A");
      });
    },
  );

  it.each(["/workspace", "/workspace/sub"])(
    "remaps relative and host aliases through the %s override and guard",
    async (target) => {
      await withTempDir("openclaw-effective-mounts-", async (root) => {
        const workspaceDir = path.join(root, "workspace");
        const override = path.join(root, "override");
        await fs.mkdir(path.join(workspaceDir, "sub"), { recursive: true });
        await fs.mkdir(override);
        await fs.writeFile(path.join(override, "marker"), "VISIBLE");
        const relative = target === "/workspace" ? "marker" : "sub/marker";
        await fs.writeFile(path.join(workspaceDir, relative), "HIDDEN");
        const sandbox = createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          workspaceAccess: "rw",
          docker: { ...createSandbox().docker, binds: [`${override}:${target}:ro`] },
        });
        const bridge = createSandboxFsBridge({ sandbox });
        for (const filePath of [
          relative,
          `/workspace/${relative}`,
          path.join(workspaceDir, relative),
        ]) {
          expect((await bridge.readFile({ filePath })).toString()).toBe("VISIBLE");
          await expect(bridge.writeFile({ filePath, data: "changed" })).rejects.toThrow(
            "read-only",
          );
        }
        expectOnlyCanonicalPathCommands();
      });
    },
  );

  it("refuses configured tmpfs and symlink aliases while allowing a deeper bind", async () => {
    await withTempDir("openclaw-effective-mounts-", async (workspaceDir) => {
      await fs.mkdir(path.join(workspaceDir, "cache"));
      await fs.mkdir(path.join(workspaceDir, "export"));
      await fs.writeFile(path.join(workspaceDir, "cache/marker"), "HIDDEN");
      await fs.writeFile(path.join(workspaceDir, "export/marker"), "VISIBLE");
      await fs.symlink("cache/marker", path.join(workspaceDir, "alias"));
      const sandbox = createSandbox({
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess: "rw",
        docker: {
          ...createSandbox().docker,
          tmpfs: ["/workspace/cache:rw"],
          binds: [`${workspaceDir}/export:/workspace/cache/export:ro`],
        },
      });
      const bridge = createSandboxFsBridge({ sandbox });
      mockContainerCanonicalPaths({ "/workspace/alias": "/workspace/cache/marker" });
      for (const filePath of [
        "cache/marker",
        "/workspace/cache/marker",
        path.join(workspaceDir, "cache/marker"),
        "alias",
      ]) {
        await expect(bridge.readFile({ filePath })).rejects.toThrow("container-only");
      }
      expect((await bridge.readFile({ filePath: "cache/export/marker" })).toString()).toBe(
        "VISIBLE",
      );
      expectOnlyCanonicalPathCommands();
    });
  });

  it("reads aliases through selected binds and same-source skill overlays", async () => {
    await withTempDir("openclaw-effective-mounts-", async (workspaceDir) => {
      for (const name of ["data", "replacement", "skills", "ordinary"]) {
        await fs.mkdir(path.join(workspaceDir, name));
        await fs.writeFile(path.join(workspaceDir, name, "marker"), name);
        await fs.symlink(`${name}/marker`, path.join(workspaceDir, `${name}-alias`));
      }
      const sandbox = createSandbox({
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess: "rw",
        docker: {
          ...createSandbox().docker,
          binds: [`${workspaceDir}/replacement:/workspace/data:ro`],
        },
      });
      const bridge = createSandboxFsBridge({ sandbox });
      mockContainerCanonicalPaths({
        "/workspace/data-alias": "/workspace/data/marker",
        "/workspace/skills-alias": "/workspace/skills/marker",
        "/workspace/ordinary-alias": "/workspace/ordinary/marker",
      });
      expect((await bridge.readFile({ filePath: "data-alias" })).toString()).toBe("replacement");
      expect((await bridge.readFile({ filePath: "data/marker" })).toString()).toBe("replacement");
      expect((await bridge.readFile({ filePath: "skills-alias" })).toString()).toBe("skills");
      expect((await bridge.readFile({ filePath: "ordinary-alias" })).toString()).toBe("ordinary");
      expectOnlyCanonicalPathCommands();
    });
  });

  it.runIf(process.platform !== "win32")(
    "uses container endpoints for reads, access, and identity across symlink hops",
    async () => {
      await withTempDir("openclaw-effective-mounts-", async (root) => {
        const workspaceDir = path.join(root, "workspace");
        const replacement = path.join(root, "replacement");
        await fs.mkdir(path.join(workspaceDir, "cache"), { recursive: true });
        await fs.mkdir(replacement);
        await fs.writeFile(path.join(workspaceDir, "visible.txt"), "A");
        await fs.symlink("../visible.txt", path.join(workspaceDir, "cache/hop"));
        await fs.symlink("cache/hop", path.join(workspaceDir, "alias"));
        await fs.symlink("/data/hop", path.join(workspaceDir, "absolute-alias"));
        await fs.writeFile(path.join(replacement, "hop"), "B");
        await fs.symlink("hop", path.join(replacement, "data-link"));
        const bridge = createSandboxFsBridge({
          sandbox: createSandbox({
            workspaceDir,
            agentWorkspaceDir: workspaceDir,
            workspaceAccess: "rw",
            docker: {
              ...createSandbox().docker,
              binds: [`${replacement}:/workspace/cache:ro`, `${replacement}:/data:ro`],
            },
          }),
        });
        mockContainerCanonicalPaths({
          "/workspace/alias": "/workspace/cache/hop",
          "/workspace/absolute-alias": "/data/hop",
          "/data/data-link": "/data/hop",
        });
        for (const filePath of ["alias", "absolute-alias", "/workspace/cache/hop", "/data/hop"]) {
          expect((await bridge.readFile({ filePath })).toString()).toBe("B");
          await expect(bridge.stat({ filePath })).resolves.not.toBeNull();
          expect(await resolveSandboxFileIdentity({ bridge, filePath })).toBe(
            path.join(replacement, "hop"),
          );
        }
        expect(await bridge.resolveReadPolicyPath!({ filePath: "alias" })).toBe(
          "/workspace/cache/hop",
        );
        expect(await bridge.resolveReadPolicyPath!({ filePath: "absolute-alias" })).toBe(
          "/data/hop",
        );
        expect(await bridge.resolveReadPolicyPath!({ filePath: "/data/hop" })).toBe("/data/hop");
        expect(await bridge.resolveReadPolicyPath!({ filePath: "/data/data-link" })).toBe(
          "/data/hop",
        );
        await expect(
          bridge.stat({
            filePath: "alias",
            expectedPolicyPath: await bridge.resolveReadPolicyPath!({ filePath: "alias" }),
          }),
        ).resolves.toMatchObject({
          type: "file",
          size: 1,
          mtimeMs: Math.trunc((await fs.stat(path.join(replacement, "hop"))).mtimeMs),
        });
        await expect(
          bridge.readFile({
            filePath: "absolute-alias",
            expectedPolicyPath: "/workspace/cache/hop",
          }),
        ).rejects.toThrow("changed after authorization");
        await expect(
          bridge.readFile({ filePath: "/data/hop", expectedPolicyPath: "/workspace/cache/hop" }),
        ).rejects.toThrow("changed after authorization");
        await expect(
          bridge.stat({ filePath: "/data/hop", expectedPolicyPath: "/workspace/cache/hop" }),
        ).rejects.toThrow("changed after authorization");
        await expect(
          bridge.stat({ filePath: "/data/hop", expectedPolicyPath: "" }),
        ).rejects.toThrow("changed after authorization");
        expect(await fs.readFile(path.join(workspaceDir, "visible.txt"), "utf8")).toBe("A");
        expect(
          mockedOpenRootFile.mock.calls.every(
            ([request]) => request.absolutePath === path.join(replacement, "hop"),
          ),
        ).toBe(true);
      });
    },
  );

  it.runIf(process.platform !== "win32").each([
    { target: "value", other: "other" },
    { target: "a\\b", other: "a/b" },
  ])(
    "closes the pinned descriptor if $target changes backing after container resolution",
    async ({ target, other }) => {
      await withTempDir("openclaw-effective-mounts-", async (workspaceDir) => {
        await fs.mkdir(path.dirname(path.join(workspaceDir, other)), { recursive: true });
        await fs.writeFile(path.join(workspaceDir, target), "VISIBLE");
        await fs.writeFile(path.join(workspaceDir, other), "HIDDEN");
        const bridge = createSandboxFsBridge({
          sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
        });
        const open = mockedOpenRootFile.getMockImplementation()!;
        let fd: number | undefined;
        let closeCallOffset = 0;
        const close = vi.spyOn(fsSync, "closeSync");
        try {
          mockedOpenRootFile.mockImplementationOnce(async (request) => {
            await fs.unlink(path.join(workspaceDir, target));
            await fs.symlink(other, path.join(workspaceDir, target));
            const result = await open(request);
            if (result.ok) {
              fd = result.fd;
              closeCallOffset = close.mock.calls.length;
            }
            return result;
          });
          await expect(
            bridge.readFile({ filePath: path.join(workspaceDir, target) }),
          ).rejects.toThrow("hidden by another mount");
          expect(fd).toBeDefined();
          // A released descriptor number can already identify another resource.
          const closeIndex = close.mock.calls.findIndex(
            ([descriptor], index) => index >= closeCallOffset && descriptor === fd,
          );
          expect(closeIndex).toBeGreaterThanOrEqual(closeCallOffset);
          expect(close.mock.results[closeIndex]).toEqual({ type: "return", value: undefined });
          expect(await fs.readFile(path.join(workspaceDir, other), "utf8")).toBe("HIDDEN");
          expectOnlyCanonicalPathCommands();
        } finally {
          close.mockRestore();
        }
      });
    },
  );

  it.runIf(process.platform !== "win32").each(["readFile", "stat"] as const)(
    "rejects a denied descriptor after its admitted path is retargeted through %s",
    async (action) => {
      await withTempDir("openclaw-effective-mounts-", async (workspaceDir) => {
        await fs.writeFile(path.join(workspaceDir, "visible"), "VISIBLE");
        await fs.writeFile(path.join(workspaceDir, "hidden"), "HIDDEN");
        const bridge = createSandboxFsBridge({
          sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
        });
        mockContainerCanonicalPaths({ "/workspace/alias": "/workspace/hidden" });
        const open = mockedOpenRootFile.getMockImplementation()!;
        mockedOpenRootFile.mockImplementationOnce(async (request) => {
          const opened = await open(request);
          await fs.unlink(path.join(workspaceDir, "hidden"));
          await fs.symlink("visible", path.join(workspaceDir, "hidden"));
          return opened;
        });

        await expect(
          bridge[action]({ filePath: "alias", expectedPolicyPath: "/workspace/visible" }),
        ).rejects.toThrow("changed after authorization");
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "reads a workspace whose root contains a literal backslash",
    async () => {
      await withTempDir("openclaw-effective-mounts-", async (root) => {
        const workspaceDir = path.join(root, "workspace\\part");
        const decoy = path.join(root, "workspace/part");
        await fs.mkdir(workspaceDir);
        await fs.mkdir(decoy, { recursive: true });
        await fs.writeFile(path.join(workspaceDir, "marker"), "LITERAL_ROOT");
        await fs.writeFile(path.join(decoy, "marker"), "SLASH_ROOT_DECOY");
        const bridge = createSandboxFsBridge({
          sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
        });
        expect((await bridge.readFile({ filePath: "marker" })).toString()).toBe("LITERAL_ROOT");
        expect(await resolveSandboxFileIdentity({ bridge, filePath: "marker" })).toBe(
          path.join(workspaceDir, "marker"),
        );
        expect(await fs.readFile(path.join(decoy, "marker"), "utf8")).toBe("SLASH_ROOT_DECOY");
      });
    },
  );

  it.runIf(process.platform === "darwin")("uses physical casing for read policy", async () => {
    await withTempDir("openclaw-effective-mounts-", async (root) => {
      const workspaceDir = path.join(root, "Workspace");
      await fs.mkdir(path.join(workspaceDir, "Private"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "Private/secret.txt"), "secret");
      try {
        await fs.stat(path.join(workspaceDir, "private/SECRET.txt"));
      } catch {
        return;
      }
      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
      });

      expect(await bridge.resolveReadPolicyPath!({ filePath: "private/SECRET.txt" })).toBe(
        "/workspace/Private/secret.txt",
      );
    });
  });

  it("keeps container-only identity separate from hidden host bytes without authorizing reads", async () => {
    await withTempDir("openclaw-effective-mounts-", async (workspaceDir) => {
      await fs.mkdir(path.join(workspaceDir, "cache"));
      await fs.writeFile(path.join(workspaceDir, "cache/value"), "HIDDEN");
      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          docker: { ...createSandbox().docker, tmpfs: ["/workspace/cache"] },
        }),
      });
      mockContainerCanonicalPaths({
        "/workspace/alias": "/workspace/cache/value",
        "/workspace/outside": "/outside/value",
      });
      for (const [filePath, canonical] of [
        ["alias", "/workspace/cache/value"],
        ["outside", "/outside/value"],
      ] as const) {
        expect(await resolveSandboxFileIdentity({ bridge, filePath })).toBe(
          `container:${canonical}`,
        );
        await expect(bridge.readFile({ filePath })).rejects.toThrow(
          /container-only|escapes allowed mounts/,
        );
      }
      expect(mockedOpenRootFile).not.toHaveBeenCalled();
    });
  });

  it.runIf(process.platform !== "win32")(
    "preserves canonical path bytes and unresolved-link identity with the real shell",
    async () => {
      await withTempDir("openclaw-effective-mounts-", async (workspaceDir) => {
        await fs.symlink("missing/target", path.join(workspaceDir, "dangling"));
        await fs.symlink("loop", path.join(workspaceDir, "loop"));
        await fs.mkdir(path.join(workspaceDir, "directory\n"));
        await fs.symlink("missing/target", path.join(workspaceDir, "directory\n/dangling\n"));
        await fs.writeFile(path.join(workspaceDir, "value\n"), "VISIBLE_NEWLINE_TARGET");
        await fs.writeFile(path.join(workspaceDir, "value"), "WRONG_TRIMMED_SIBLING");
        await fs.symlink("value\n", path.join(workspaceDir, "alias"));
        const guard = new SandboxFsPathGuard({
          mountsByContainer: [
            {
              hostRoot: workspaceDir,
              containerRoot: workspaceDir,
              writable: true,
              source: "workspace",
            },
          ],
          runCommand: async (script, options) => {
            const { stdout } = await promisify(execFile)(
              "sh",
              ["-c", script, "identity-test", ...(options?.args ?? [])],
              { encoding: "buffer" },
            );
            return { stdout };
          },
        });
        const aliasPath = path.join(workspaceDir, "alias");
        const aliasTarget = {
          containerPath: aliasPath,
          hostPath: aliasPath,
          relativePath: "alias",
          writable: true,
        };
        const opened = await guard.openReadableFile(aliasTarget);
        try {
          expect(fsSync.readFileSync(opened.fd, "utf8")).toBe("VISIBLE_NEWLINE_TARGET");
        } finally {
          fsSync.closeSync(opened.fd);
        }
        expect(await guard.resolveFileIdentity(aliasTarget)).toBe(
          path.join(workspaceDir, "value\n"),
        );
        for (const relativePath of [
          "",
          "dangling",
          "loop",
          "missing/leaf",
          "missing\n/leaf\n",
          "directory\n/missing\n/leaf\n",
          "directory\n/dangling\n",
        ]) {
          const filePath = path.join(workspaceDir, relativePath);
          const target = {
            containerPath: filePath,
            hostPath: filePath,
            relativePath,
            writable: true,
          };
          expect(await guard.resolveFileIdentity(target)).toBe(filePath);
        }
        const danglingPath = path.join(workspaceDir, "directory\n/dangling\n");
        const danglingTarget = {
          containerPath: danglingPath,
          hostPath: danglingPath,
          relativePath: "directory\n/dangling\n",
          writable: true,
        };
        await expect(guard.openReadableFile(danglingTarget)).rejects.toThrow();
        expect(await guard.resolveAnchoredSandboxEntry(danglingTarget, "unlink files")).toEqual({
          canonicalParentPath: path.join(workspaceDir, "directory\n"),
          basename: "dangling\n",
        });
        expect((await fs.lstat(path.join(workspaceDir, "dangling"))).isSymbolicLink()).toBe(true);
        expect((await fs.lstat(path.join(workspaceDir, "loop"))).isSymbolicLink()).toBe(true);
        expect((await fs.lstat(danglingPath)).isSymbolicLink()).toBe(true);
        expect(await fs.readFile(path.join(workspaceDir, "value"), "utf8")).toBe(
          "WRONG_TRIMMED_SIBLING",
        );
      });
    },
  );

  it.each(["ancestor", "same", ...(process.platform === "win32" ? [] : ["symlink", "canonical"])])(
    "keeps the default workspace alias ahead of a %s custom source",
    async (source) => {
      await withTempDir("openclaw-effective-mounts-", async (root) => {
        const actualWorkspace = path.join(root, "project/work");
        const workspaceDir =
          source === "symlink" || source === "canonical" ? path.join(root, "ws") : actualWorkspace;
        const replacement = path.join(root, "replacement");
        await fs.mkdir(actualWorkspace, { recursive: true });
        if (workspaceDir !== actualWorkspace) {
          await fs.symlink(actualWorkspace, workspaceDir, "dir");
        }
        await fs.mkdir(replacement);
        await fs.writeFile(path.join(workspaceDir, "marker"), "HIDDEN");
        await fs.writeFile(path.join(replacement, "marker"), "VISIBLE");
        const sandbox = createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          workspaceAccess: "rw",
          docker: {
            ...createSandbox().docker,
            binds: [
              ...(source === "canonical"
                ? []
                : [`${source === "ancestor" ? `${root}/project` : actualWorkspace}:/data:rw`]),
              `${replacement}:/workspace:ro`,
            ],
          },
        });
        const bridge = createSandboxFsBridge({ sandbox });
        for (const filePath of [
          "marker",
          path.join(workspaceDir, "marker"),
          "/workspace/marker",
          ...(source === "canonical" ? [path.join(actualWorkspace, "marker")] : []),
        ]) {
          expect((await bridge.readFile({ filePath })).toString()).toBe("VISIBLE");
          await expect(bridge.writeFile({ filePath, data: "changed" })).rejects.toThrow(
            "read-only",
          );
        }
        if (source !== "canonical") {
          expect(
            (
              await bridge.readFile({
                filePath: source === "ancestor" ? "/data/work/marker" : "/data/marker",
              })
            ).toString(),
          ).toBe("HIDDEN");
        }
      });
    },
  );

  it("reads a same-source overlay reached through a declared source symlink", async () => {
    await withTempDir("openclaw-effective-mounts-", async (workspaceDir) => {
      await fs.mkdir(path.join(workspaceDir, "data"));
      await fs.writeFile(path.join(workspaceDir, "data/marker"), "VISIBLE");
      await fs.symlink("data", path.join(workspaceDir, "source-alias"), "dir");
      await fs.symlink("data/marker", path.join(workspaceDir, "read-alias"));
      const sandbox = createSandbox({
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess: "rw",
        docker: {
          ...createSandbox().docker,
          binds: [`${workspaceDir}/source-alias:/workspace/data:ro`],
        },
      });
      const bridge = createSandboxFsBridge({ sandbox });
      mockContainerCanonicalPaths({ "/workspace/read-alias": "/workspace/data/marker" });
      for (const filePath of ["read-alias", "data/marker"]) {
        expect((await bridge.readFile({ filePath })).toString()).toBe("VISIBLE");
      }
      expectOnlyCanonicalPathCommands();
    });
  });

  it.runIf(process.platform !== "win32")(
    "preserves distinct whitespace in bind sources and destinations",
    async () => {
      await withTempDir("openclaw-effective-mounts-", async (workspaceDir) => {
        for (const name of ["A", "B "]) {
          await fs.mkdir(path.join(workspaceDir, name));
          await fs.writeFile(path.join(workspaceDir, name, "marker"), name);
        }
        const sandbox = createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          workspaceAccess: "rw",
          docker: {
            ...createSandbox().docker,
            binds: [`${workspaceDir}/A:/data:ro`, `${workspaceDir}/B :/data :rw`],
          },
        });
        const bridge = createSandboxFsBridge({ sandbox });
        expect((await bridge.readFile({ filePath: "/data/marker" })).toString()).toBe("A");
        expect((await bridge.readFile({ filePath: "/data /marker" })).toString()).toBe("B ");
        expect(bridge.resolvePath({ filePath: "/data " }).hostPath).toBe(
          path.join(workspaceDir, "B "),
        );
        expect(resolveWritableSandboxBindHostRoots(sandbox.docker.binds)).toEqual([
          path.join(workspaceDir, "B "),
        ]);
        mockedExecDockerRaw.mockImplementation(async (args) => {
          if (getDockerScript(args).includes('readlink -n -f -- "$cursor"')) {
            return dockerExecResult(`${getDockerArg(args, 1)}\n`);
          }
          return dockerExecResult(getDockerArg(args, 1) === "readdir" ? "[]" : "");
        });
        await bridge.writeFile({ filePath: "/data /marker", data: "updated" });
        await bridge.readDirectory!({ filePath: "/data " });
        for (const operation of ["write", "readdir"]) {
          const call = mockedExecDockerRaw.mock.calls.find(
            ([args]) => getDockerArg(args, 1) === operation,
          );
          expect(call).toBeDefined();
          expect(getDockerArg(call![0], 2)).toBe("/data ");
          expect(getDockerArg(call![0], 3)).toBe("");
        }
        await expect(
          bridge.writeFile({ filePath: "/data/marker", data: "denied" }),
        ).rejects.toThrow("read-only");
      });
    },
  );
});
