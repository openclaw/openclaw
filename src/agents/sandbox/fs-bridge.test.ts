import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSandbox,
  createSandboxFsBridge,
  createSeededSandboxFsBridge,
  expectMkdirpAllowsExistingDirectory,
  findCallByDockerArg,
  findCallByScriptFragment,
  getDockerArg,
  getScriptsFromCalls,
  installDockerReadMock,
  installFsBridgeTestHarness,
  mockedExecDockerRaw,
  mockedOpenBoundaryFile,
  withTempDir,
} from "./fs-bridge.test-helpers.js";

describe("sandbox fs bridge shell compatibility", () => {
  installFsBridgeTestHarness();

  it("uses POSIX-safe shell prologue in all docker bridge commands", async () => {
    await withTempDir("openclaw-fs-bridge-shell-", async (stateDir) => {
      const { bridge } = await createSeededSandboxFsBridge(stateDir);

      await bridge.writeFile({ filePath: "b.txt", data: "hello" });
      await bridge.mkdirp({ filePath: "nested" });
      await bridge.remove({ filePath: "b.txt" });
      await bridge.rename({ from: "from.txt", to: "renamed.txt" });
      await bridge.stat({ filePath: "renamed.txt" });

      expect(mockedExecDockerRaw).toHaveBeenCalled();

      const scripts = getScriptsFromCalls();
      const executables = mockedExecDockerRaw.mock.calls.map(([args]) => args[3] ?? "");

      expect(executables.every((shell) => shell === "sh")).toBe(true);
      expect(scripts.every((script) => /set -eu[;\n]/.test(script))).toBe(true);
      expect(scripts.some((script) => script.includes("pipefail"))).toBe(false);
    });
  });

  it("resolveCanonicalContainerPath script is valid POSIX sh (no do; token)", async () => {
    await withTempDir("openclaw-fs-bridge-canonical-", async (stateDir) => {
      const { bridge } = await createSeededSandboxFsBridge(stateDir);

      await bridge.writeFile({ filePath: "b.txt", data: "hello" });

      const scripts = getScriptsFromCalls();
      const canonicalScript = scripts.find((script) => script.includes("allow_final"));
      expect(canonicalScript).toBeDefined();
      expect(canonicalScript).not.toMatch(/\bdo;/);
      expect(canonicalScript).toMatch(/\bdo\n\s*parent=/);
    });
  });

  it("resolves inbound media-style filenames with triple-dash ids", async () => {
    await withTempDir("openclaw-fs-bridge-inbound-", async (stateDir) => {
      const inboundPath = "media/inbound/file_1095---f00a04a2-99a0-4d98-99b0-dfe61c5a4198.ogg";
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(path.join(workspaceDir, "media", "inbound"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, inboundPath), "audio");
      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
      });

      const resolved = bridge.resolvePath({ filePath: inboundPath });
      expect(resolved.containerPath).toContain("file_1095---");

      const data = await bridge.readFile({ filePath: inboundPath });
      expect(data.toString("utf8")).toBe("audio");
      expect(mockedExecDockerRaw).not.toHaveBeenCalled();
    });
  });

  it("resolves dash-leading basenames into absolute container paths", async () => {
    await withTempDir("openclaw-fs-bridge-leading-", async (stateDir) => {
      const { bridge } = await createSeededSandboxFsBridge(stateDir, {
        rootFileName: "--leading.txt",
        rootContents: "leading",
      });

      const resolved = bridge.resolvePath({ filePath: "--leading.txt" });
      expect(resolved.containerPath).toBe("/workspace/--leading.txt");

      const data = await bridge.readFile({ filePath: "--leading.txt" });
      expect(data.toString("utf8")).toBe("leading");
      expect(mockedExecDockerRaw).not.toHaveBeenCalled();
    });
  });

  it("resolves bind-mounted absolute container paths for reads", async () => {
    await withTempDir("openclaw-fs-bridge-bind-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      const bindDir = path.join(stateDir, "workspace-two");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(bindDir, { recursive: true });
      await fs.writeFile(path.join(bindDir, "README.md"), "bound");

      const sandbox = createSandbox({
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        docker: {
          ...createSandbox().docker,
          binds: [`${bindDir}:/workspace-two:ro`],
        },
      });
      const fsBridge = createSandboxFsBridge({ sandbox });

      const resolved = fsBridge.resolvePath({ filePath: "/workspace-two/README.md" });
      expect(resolved.containerPath).toBe("/workspace-two/README.md");
      expect(
        (await fsBridge.readFile({ filePath: "/workspace-two/README.md" })).toString("utf8"),
      ).toBe("bound");
      expect(mockedExecDockerRaw).not.toHaveBeenCalled();
    });
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

  it("writes via the pinned helper plan instead of inline truncation", async () => {
    await withTempDir("openclaw-fs-bridge-write-", async (stateDir) => {
      const { bridge } = await createSeededSandboxFsBridge(stateDir);

      await bridge.writeFile({ filePath: "b.txt", data: "hello" });

      const writeCall = findCallByDockerArg(1, "write");
      expect(writeCall).toBeDefined();
      const args = writeCall?.[0] ?? [];
      expect(args[3]).toBe("sh");
      expect(args[5]).toContain("python3 /dev/fd/3");
      expect(getDockerArg(args, 2)).toBe("/workspace");
      expect(getDockerArg(args, 3)).toBe("");
      expect(getDockerArg(args, 4)).toBe("b.txt");
      expect(getDockerArg(args, 5)).toBe("1");
    });
  });

  it("re-validates target before mutation command runs", async () => {
    mockedOpenBoundaryFile
      .mockImplementationOnce(async () => ({ ok: false, reason: "path" }))
      .mockImplementationOnce(async () => ({
        ok: false,
        reason: "validation",
        error: new Error("Hardlinked path is not allowed"),
      }));

    await withTempDir("openclaw-fs-bridge-recheck-", async (stateDir) => {
      const { bridge } = await createSeededSandboxFsBridge(stateDir);

      await expect(bridge.writeFile({ filePath: "b.txt", data: "hello" })).rejects.toThrow(
        /hardlinked path/i,
      );
      expect(findCallByDockerArg(1, "write")).toBeUndefined();
    });
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
      expect(mockedExecDockerRaw).not.toHaveBeenCalled();
    });
  });

  it("rejects container-canonicalized paths outside allowed mounts", async () => {
    installDockerReadMock({ canonicalPath: "/etc/passwd" });

    await withTempDir("openclaw-fs-bridge-canonical-escape-", async (stateDir) => {
      const { bridge } = await createSeededSandboxFsBridge(stateDir);
      await expect(bridge.writeFile({ filePath: "b.txt", data: "hello" })).rejects.toThrow(
        /escapes allowed mounts/i,
      );
      const readCall = findCallByScriptFragment('cat -- "$1"');
      expect(readCall).toBeUndefined();
    });
  });
});
