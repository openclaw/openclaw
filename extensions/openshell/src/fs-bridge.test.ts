import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSandboxTestContext } from "../../../src/agents/sandbox/test-fixtures.js";
import type { OpenShellSandboxBackend } from "./backend.js";
import { createOpenShellFsBridge } from "./fs-bridge.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-openshell-fs-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function createBackendMock(): OpenShellSandboxBackend {
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

describe("openshell fs bridge", () => {
  it("writes locally and syncs the file to the remote workspace", async () => {
    const workspaceDir = await makeTempDir();
    const backend = createBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        containerWorkdir: "/sandbox",
      },
    });

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
    const workspaceDir = await makeTempDir();
    const agentWorkspaceDir = await makeTempDir();
    await fs.writeFile(path.join(agentWorkspaceDir, "note.txt"), "agent", "utf8");
    const backend = createBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir,
        workspaceAccess: "ro",
        containerWorkdir: "/sandbox",
      },
    });

    const bridge = createOpenShellFsBridge({ sandbox, backend });
    const resolved = bridge.resolvePath({ filePath: "/agent/note.txt" });
    expect(resolved.hostPath).toBe(path.join(agentWorkspaceDir, "note.txt"));
    expect(await bridge.readFile({ filePath: "/agent/note.txt" })).toEqual(Buffer.from("agent"));
  });
});
