import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxTestContext } from "../../../src/agents/sandbox/test-fixtures.js";
import type { OpenShellSandboxBackend } from "./backend.js";
import {
  buildExecRemoteCommand,
  buildOpenShellBaseArgv,
  resolveOpenShellCommand,
  setBundledOpenShellCommandResolverForTest,
  shellEscape,
} from "./cli.js";
import { resolveOpenShellPluginConfig } from "./config.js";

const cliMocks = vi.hoisted(() => ({
  runOpenShellCli: vi.fn(),
}));

let createOpenShellSandboxBackendManager: typeof import("./backend.js").createOpenShellSandboxBackendManager;

describe("openshell cli helpers", () => {
  afterEach(() => {
    setBundledOpenShellCommandResolverForTest();
  });

  it("builds base argv with gateway overrides", () => {
    const config = resolveOpenShellPluginConfig({
      command: "/usr/local/bin/openshell",
      gateway: "lab",
      gatewayEndpoint: "https://lab.example",
    });
    expect(buildOpenShellBaseArgv(config)).toEqual([
      "/usr/local/bin/openshell",
      "--gateway",
      "lab",
      "--gateway-endpoint",
      "https://lab.example",
    ]);
  });

  it("prefers the bundled openshell command when available", () => {
    setBundledOpenShellCommandResolverForTest(() => "/tmp/node_modules/.bin/openshell");
    const config = resolveOpenShellPluginConfig(undefined);

    expect(resolveOpenShellCommand("openshell")).toBe("/tmp/node_modules/.bin/openshell");
    expect(buildOpenShellBaseArgv(config)).toEqual(["/tmp/node_modules/.bin/openshell"]);
  });

  it("falls back to the PATH command when no bundled openshell is present", () => {
    setBundledOpenShellCommandResolverForTest(() => null);

    expect(resolveOpenShellCommand("openshell")).toBe("openshell");
  });

  it("shell escapes single quotes", () => {
    expect(shellEscape(`a'b`)).toBe(`'a'"'"'b'`);
  });

  it("wraps exec commands with env and workdir", () => {
    const command = buildExecRemoteCommand({
      command: "pwd && printenv TOKEN",
      workdir: "/sandbox/project",
      env: {
        TOKEN: "abc 123",
      },
    });
    expect(command).toContain(`'env'`);
    expect(command).toContain(`'TOKEN=abc 123'`);
    expect(command).toContain(`'cd '"'"'/sandbox/project'"'"' && pwd && printenv TOKEN'`);
  });
});

describe("openshell backend manager", () => {
  beforeAll(async () => {
    vi.doMock("./cli.js", async () => {
      const actual = await vi.importActual<typeof import("./cli.js")>("./cli.js");
      return {
        ...actual,
        runOpenShellCli: cliMocks.runOpenShellCli,
      };
    });
    ({ createOpenShellSandboxBackendManager } = await import("./backend.js"));
  });

  afterAll(() => {
    vi.doUnmock("./cli.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("checks runtime status with config override from OpenClaw config", async () => {
    cliMocks.runOpenShellCli.mockResolvedValue({
      code: 0,
      stdout: "{}",
      stderr: "",
    });

    const manager = createOpenShellSandboxBackendManager({
      pluginConfig: resolveOpenShellPluginConfig({
        command: "openshell",
        from: "openclaw",
      }),
    });

    const result = await manager.describeRuntime({
      entry: {
        containerName: "openclaw-session-1234",
        backendId: "openshell",
        runtimeLabel: "openclaw-session-1234",
        sessionKey: "agent:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "custom-source",
        configLabelKind: "Source",
      },
      config: {
        plugins: {
          entries: {
            openshell: {
              enabled: true,
              config: {
                command: "openshell",
                from: "custom-source",
              },
            },
          },
        },
      },
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "custom-source",
      configLabelMatch: true,
    });
    expect(cliMocks.runOpenShellCli).toHaveBeenCalledWith({
      context: expect.objectContaining({
        sandboxName: "openclaw-session-1234",
        config: expect.objectContaining({
          from: "custom-source",
        }),
      }),
      args: ["sandbox", "get", "openclaw-session-1234"],
    });
  });

  it("removes runtimes via openshell sandbox delete", async () => {
    cliMocks.runOpenShellCli.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });

    const manager = createOpenShellSandboxBackendManager({
      pluginConfig: resolveOpenShellPluginConfig({
        command: "/usr/local/bin/openshell",
        gateway: "lab",
      }),
    });

    await manager.removeRuntime({
      entry: {
        containerName: "openclaw-session-5678",
        backendId: "openshell",
        runtimeLabel: "openclaw-session-5678",
        sessionKey: "agent:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "openclaw",
        configLabelKind: "Source",
      },
      config: {},
    });

    expect(cliMocks.runOpenShellCli).toHaveBeenCalledWith({
      context: expect.objectContaining({
        sandboxName: "openclaw-session-5678",
        config: expect.objectContaining({
          command: "/usr/local/bin/openshell",
          gateway: "lab",
        }),
      }),
      args: ["sandbox", "delete", "openclaw-session-5678"],
    });
  });
});

const tempDirs: string[] = [];

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function createMirrorBackendMock(): OpenShellSandboxBackend {
  return {
    id: "openshell",
    runtimeId: "openshell-test",
    runtimeLabel: "openshell-test",
    workdir: "/sandbox",
    env: {},
    remoteWorkspaceDir: "/sandbox",
    remoteAgentWorkspaceDir: "/agent",
    buildExecSpec: vi.fn(),
    runShellCommand: vi.fn(),
    runRemoteShellScript: vi.fn().mockResolvedValue({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: 0,
    }),
    syncLocalPathToRemote: vi.fn().mockResolvedValue(undefined),
  } as unknown as OpenShellSandboxBackend;
}

function translateRemotePath(value: string, roots: { workspace: string; agent: string }) {
  if (value === "/sandbox" || value.startsWith("/sandbox/")) {
    return path.join(roots.workspace, value.slice("/sandbox".length));
  }
  if (value === "/agent" || value.startsWith("/agent/")) {
    return path.join(roots.agent, value.slice("/agent".length));
  }
  return value;
}

async function runLocalShell(params: {
  script: string;
  args?: string[];
  stdin?: Buffer | string;
  allowFailure?: boolean;
  roots: { workspace: string; agent: string };
}) {
  const translatedArgs = (params.args ?? []).map((arg) => translateRemotePath(arg, params.roots));
  const stdinBuffer =
    params.stdin === undefined
      ? undefined
      : Buffer.isBuffer(params.stdin)
        ? params.stdin
        : Buffer.from(params.stdin);
  const result = await emulateRemoteShell({
    script: params.script,
    args: translatedArgs,
    stdin: stdinBuffer,
    allowFailure: params.allowFailure,
  });
  return {
    ...result,
    stdout: Buffer.from(rewriteLocalPaths(result.stdout.toString("utf8"), params.roots), "utf8"),
  };
}

function createRemoteBackendMock(roots: {
  workspace: string;
  agent: string;
}): OpenShellSandboxBackend {
  return {
    id: "openshell",
    runtimeId: "openshell-test",
    runtimeLabel: "openshell-test",
    workdir: "/sandbox",
    env: {},
    mode: "remote",
    remoteWorkspaceDir: "/sandbox",
    remoteAgentWorkspaceDir: "/agent",
    buildExecSpec: vi.fn(),
    runShellCommand: vi.fn(),
    runRemoteShellScript: vi.fn(
      async (params) =>
        await runLocalShell({
          ...params,
          roots,
        }),
    ),
    syncLocalPathToRemote: vi.fn().mockResolvedValue(undefined),
  } as unknown as OpenShellSandboxBackend;
}

function rewriteLocalPaths(value: string, roots: { workspace: string; agent: string }) {
  return value.replaceAll(roots.workspace, "/sandbox").replaceAll(roots.agent, "/agent");
}

async function emulateRemoteShell(params: {
  script: string;
  args: string[];
  stdin?: Buffer;
  allowFailure?: boolean;
}): Promise<{ stdout: Buffer; stderr: Buffer; code: number }> {
  try {
    if (params.script === 'set -eu\ncat -- "$1"') {
      return { stdout: await fs.readFile(params.args[0] ?? ""), stderr: Buffer.alloc(0), code: 0 };
    }

    if (
      params.script === 'if [ -e "$1" ] || [ -L "$1" ]; then printf "1\\n"; else printf "0\\n"; fi'
    ) {
      const target = params.args[0] ?? "";
      const exists = await pathExistsOrSymlink(target);
      return { stdout: Buffer.from(exists ? "1\n" : "0\n"), stderr: Buffer.alloc(0), code: 0 };
    }

    if (params.script.includes('canonical=$(readlink -f -- "$cursor")')) {
      const canonical = await resolveCanonicalPath(params.args[0] ?? "", params.args[1] === "1");
      return { stdout: Buffer.from(`${canonical}\n`), stderr: Buffer.alloc(0), code: 0 };
    }

    if (params.script.includes('stats=$(stat -c "%F|%h" -- "$1")')) {
      const target = params.args[0] ?? "";
      if (!(await pathExistsOrSymlink(target))) {
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
      }
      const stats = await fs.lstat(target);
      return {
        stdout: Buffer.from(`${describeKind(stats)}|${String(stats.nlink)}\n`),
        stderr: Buffer.alloc(0),
        code: 0,
      };
    }

    if (params.script.includes('stat -c "%F|%s|%Y" -- "$1"')) {
      const target = params.args[0] ?? "";
      const stats = await fs.lstat(target);
      return {
        stdout: Buffer.from(
          `${describeKind(stats)}|${String(stats.size)}|${String(Math.trunc(stats.mtimeMs / 1000))}\n`,
        ),
        stderr: Buffer.alloc(0),
        code: 0,
      };
    }

    if (params.script.includes("python3 /dev/fd/3 \"$@\" 3<<'PY'")) {
      const stdout = (await applyMutation(params.args, params.stdin)) ?? Buffer.alloc(0);
      return { stdout, stderr: Buffer.alloc(0), code: 0 };
    }

    throw new Error(`unsupported remote shell script: ${params.script}`);
  } catch (error) {
    if (!params.allowFailure) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: Buffer.alloc(0), stderr: Buffer.from(message), code: 1 };
  }
}

async function pathExistsOrSymlink(target: string) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

function describeKind(stats: fsSync.Stats) {
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isFile()) {
    return "regular file";
  }
  return "other";
}

async function resolveCanonicalPath(target: string, allowFinalSymlink: boolean) {
  let suffix = "";
  let cursor = target;
  if (allowFinalSymlink && (await isSymlink(target))) {
    cursor = path.dirname(target);
  }
  while (!(await pathExistsOrSymlink(cursor))) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    suffix = `${path.posix.sep}${path.basename(cursor)}${suffix}`;
    cursor = parent;
  }
  const canonical = await fs.realpath(cursor);
  return `${canonical}${suffix}`;
}

async function isSymlink(target: string) {
  try {
    return (await fs.lstat(target)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function applyMutation(args: string[], stdin?: Buffer): Promise<Buffer | void> {
  const operation = args[0];
  if (operation === "read") {
    const [root, relativeParent, basename] = args.slice(1);
    return await fs.readFile(path.join(root ?? "", relativeParent ?? "", basename ?? ""));
  }
  if (operation === "write") {
    const [root, relativeParent, basename, mkdir] = args.slice(1);
    const parent = path.join(root ?? "", relativeParent ?? "");
    if (mkdir === "1") {
      await fs.mkdir(parent, { recursive: true });
    }
    await fs.writeFile(path.join(parent, basename ?? ""), stdin ?? Buffer.alloc(0));
    return;
  }
  if (operation === "mkdirp") {
    const [root, relativePath] = args.slice(1);
    await fs.mkdir(path.join(root ?? "", relativePath ?? ""), { recursive: true });
    return;
  }
  if (operation === "remove") {
    const [root, relativeParent, basename, recursive, force] = args.slice(1);
    const target = path.join(root ?? "", relativeParent ?? "", basename ?? "");
    await fs.rm(target, { recursive: recursive === "1", force: force !== "0" });
    return;
  }
  if (operation === "rename") {
    const [srcRoot, srcParent, srcBase, dstRoot, dstParent, dstBase, mkdir] = args.slice(1);
    const source = path.join(srcRoot ?? "", srcParent ?? "", srcBase ?? "");
    const destinationParent = path.join(dstRoot ?? "", dstParent ?? "");
    if (mkdir === "1") {
      await fs.mkdir(destinationParent, { recursive: true });
    }
    await fs.rename(source, path.join(destinationParent, dstBase ?? ""));
    return;
  }
  throw new Error(`unknown mutation operation: ${operation}`);
}

describe("openshell fs bridges", () => {
  it("writes locally and syncs the file to the remote workspace", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const backend = createMirrorBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });
    await bridge.writeFile({
      filePath: "nested/file.txt",
      data: "hello",
      mkdir: true,
    });

    expect(await fs.readFile(path.join(workspaceDir, "nested", "file.txt"), "utf8")).toBe("hello");
    expect(backend.syncLocalPathToRemote).toHaveBeenCalledWith(
      path.join(workspaceDir, "nested", "file.txt"),
      "/sandbox/nested/file.txt",
    );
  });

  it("maps agent mount paths when the sandbox workspace is read-only", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const agentWorkspaceDir = await makeTempDir("openclaw-openshell-agent-");
    await fs.writeFile(path.join(agentWorkspaceDir, "note.txt"), "agent", "utf8");
    const backend = createMirrorBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir,
        workspaceAccess: "ro",
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });
    const resolved = bridge.resolvePath({ filePath: "/agent/note.txt" });
    expect(resolved.hostPath).toBe(path.join(agentWorkspaceDir, "note.txt"));
    expect(await bridge.readFile({ filePath: "/agent/note.txt" })).toEqual(Buffer.from("agent"));
  });

  it("writes, reads, renames, and removes files without local host paths", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-remote-local-");
    const remoteWorkspaceDir = await makeTempDir("openclaw-openshell-remote-workspace-");
    const remoteAgentDir = await makeTempDir("openclaw-openshell-remote-agent-");
    const remoteWorkspaceRealDir = await fs.realpath(remoteWorkspaceDir);
    const remoteAgentRealDir = await fs.realpath(remoteAgentDir);
    const backend = createRemoteBackendMock({
      workspace: remoteWorkspaceRealDir,
      agent: remoteAgentRealDir,
    });
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellRemoteFsBridge } = await import("./remote-fs-bridge.js");
    const bridge = createOpenShellRemoteFsBridge({ sandbox, backend });
    await bridge.writeFile({
      filePath: "nested/file.txt",
      data: "hello",
      mkdir: true,
    });

    expect(await fs.readFile(path.join(remoteWorkspaceRealDir, "nested", "file.txt"), "utf8")).toBe(
      "hello",
    );
    expect(await fs.readdir(workspaceDir)).toEqual([]);

    const resolved = bridge.resolvePath({ filePath: "nested/file.txt" });
    expect(resolved.hostPath).toBeUndefined();
    expect(resolved.containerPath).toBe("/sandbox/nested/file.txt");
    expect(await bridge.readFile({ filePath: "nested/file.txt" })).toEqual(Buffer.from("hello"));
    expect(await bridge.stat({ filePath: "nested/file.txt" })).toEqual(
      expect.objectContaining({
        type: "file",
        size: 5,
      }),
    );

    await bridge.rename({
      from: "nested/file.txt",
      to: "nested/renamed.txt",
    });
    await expect(
      fs.readFile(path.join(remoteWorkspaceRealDir, "nested", "file.txt"), "utf8"),
    ).rejects.toBeDefined();
    expect(
      await fs.readFile(path.join(remoteWorkspaceRealDir, "nested", "renamed.txt"), "utf8"),
    ).toBe("hello");

    await bridge.remove({
      filePath: "nested/renamed.txt",
    });
    await expect(
      fs.readFile(path.join(remoteWorkspaceRealDir, "nested", "renamed.txt"), "utf8"),
    ).rejects.toBeDefined();
  });
});
