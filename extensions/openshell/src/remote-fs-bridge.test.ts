import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSandboxTestContext } from "../../../src/agents/sandbox/test-fixtures.js";
import type { OpenShellSandboxBackend } from "./backend.js";
import { createOpenShellRemoteFsBridge } from "./remote-fs-bridge.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

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

function createBackendMock(roots: { workspace: string; agent: string }): OpenShellSandboxBackend {
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

    if (params.script === 'if [ -e "$1" ] || [ -L "$1" ]; then printf "1\\n"; else printf "0\\n"; fi') {
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

    if (params.script.includes('python3 /dev/fd/3 "$@" 3<<\'PY\'')) {
      await applyMutation(params.args, params.stdin);
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
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

async function applyMutation(args: string[], stdin?: Buffer) {
  const operation = args[0];
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

describe("openshell remote fs bridge", () => {
  it("writes, reads, renames, and removes files without local host paths", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-remote-local-");
    const remoteWorkspaceDir = await makeTempDir("openclaw-openshell-remote-workspace-");
    const remoteAgentDir = await makeTempDir("openclaw-openshell-remote-agent-");
    const remoteWorkspaceRealDir = await fs.realpath(remoteWorkspaceDir);
    const remoteAgentRealDir = await fs.realpath(remoteAgentDir);
    const backend = createBackendMock({
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
