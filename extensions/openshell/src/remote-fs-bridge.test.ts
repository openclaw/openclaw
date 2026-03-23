import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSandboxTestContext } from "../../../src/agents/sandbox/test-fixtures.js";
import type { OpenShellSandboxBackend } from "./backend.js";
import { createOpenShellRemoteFsBridge } from "./remote-fs-bridge.js";

const tempDirs: string[] = [];
const localPythonBin = (() => {
  try {
    return execFileSync("python3", ["-c", "import sys; print(sys.executable)"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "python3";
  }
})();

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
  const script = normalizeScriptForLocalShell(params.script);
  const result = await new Promise<{ stdout: Buffer; stderr: Buffer; code: number }>(
    (resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", script, "openshell-test", ...translatedArgs], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
      child.on("error", reject);
      child.on("close", (code) => {
        const result = {
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
          code: code ?? 0,
        };
        if (result.code !== 0 && !params.allowFailure) {
          reject(
            new Error(
              result.stderr.toString("utf8").trim() || `script exited with code ${result.code}`,
            ),
          );
          return;
        }
        resolve(result);
      });
      if (params.stdin !== undefined) {
        child.stdin.end(params.stdin);
        return;
      }
      child.stdin.end();
    },
  );
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

function normalizeScriptForLocalShell(script: string) {
  return script
    .replace(
      'stats=$(stat -c "%F|%h" -- "$1")',
      `stats=$(${localPythonBin} - "$1" <<'PY'
import os, stat, sys
st = os.stat(sys.argv[1])
kind = 'directory' if stat.S_ISDIR(st.st_mode) else 'regular file' if stat.S_ISREG(st.st_mode) else 'other'
print(f"{kind}|{st.st_nlink}")
PY
)`,
    )
    .replace(
      'stat -c "%F|%s|%Y" -- "$1"',
      `${localPythonBin} - "$1" <<'PY'
import os, stat, sys
st = os.stat(sys.argv[1])
kind = 'directory' if stat.S_ISDIR(st.st_mode) else 'regular file' if stat.S_ISREG(st.st_mode) else 'other'
print(f"{kind}|{st.st_size}|{int(st.st_mtime)}")
PY`,
    )
    .replace("python3 /dev/fd/3", `${localPythonBin} /dev/fd/3`);
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
