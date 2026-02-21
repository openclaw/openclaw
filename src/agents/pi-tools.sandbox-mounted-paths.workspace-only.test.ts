import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawCodingTools } from "./pi-tools.js";
import type { SandboxContext } from "./sandbox.js";
import type { SandboxFsBridge, SandboxResolvedPath } from "./sandbox/fs-bridge.js";
import { createSandboxFsBridgeFromResolver } from "./test-helpers/host-sandbox-fs-bridge.js";
import {
  expectReadWriteEditTools,
  expectReadWriteTools,
  getTextContent,
} from "./test-helpers/pi-tools-fs-helpers.js";
import { createPiToolsSandboxContext } from "./test-helpers/pi-tools-sandbox-context.js";

vi.mock("../infra/shell-env.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/shell-env.js")>();
  return { ...mod, getShellPathFromLoginShell: () => null };
});

function createUnsafeMountedBridge(params: {
  root: string;
  agentHostRoot: string;
  workspaceContainerRoot?: string;
}): SandboxFsBridge {
  const root = path.resolve(params.root);
  const agentHostRoot = path.resolve(params.agentHostRoot);
  const workspaceContainerRoot = params.workspaceContainerRoot ?? "/workspace";

  const resolvePath = (filePath: string, cwd?: string): SandboxResolvedPath => {
    // Intentionally unsafe: simulate a sandbox FS bridge that maps /agent/* into a host path
    // outside the workspace root (e.g. an operator-configured bind mount).
    const hostPath =
      filePath === "/agent" || filePath === "/agent/" || filePath.startsWith("/agent/")
        ? path.join(
            agentHostRoot,
            filePath === "/agent" || filePath === "/agent/" ? "" : filePath.slice("/agent/".length),
          )
        : path.isAbsolute(filePath)
          ? filePath
          : path.resolve(cwd ?? root, filePath);

    const relFromRoot = path.relative(root, hostPath);
    const relativePath =
      relFromRoot && !relFromRoot.startsWith("..") && !path.isAbsolute(relFromRoot)
        ? relFromRoot.split(path.sep).filter(Boolean).join(path.posix.sep)
        : filePath.replace(/\\/g, "/");

    const containerPath = filePath.startsWith("/")
      ? filePath.replace(/\\/g, "/")
      : relativePath
        ? path.posix.join(workspaceContainerRoot, relativePath)
        : workspaceContainerRoot;

    return { hostPath, relativePath, containerPath };
  };

  return createSandboxFsBridgeFromResolver(resolvePath);
}

function createSandbox(params: {
  sandboxRoot: string;
  agentRoot: string;
  fsBridge: SandboxFsBridge;
}): SandboxContext {
  return createPiToolsSandboxContext({
    workspaceDir: params.sandboxRoot,
    agentWorkspaceDir: params.agentRoot,
    workspaceAccess: "rw",
    fsBridge: params.fsBridge,
    tools: { allow: [], deny: [] },
  });
}

async function withUnsafeMountedSandboxHarness(
  run: (ctx: { sandboxRoot: string; agentRoot: string; sandbox: SandboxContext }) => Promise<void>,
) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sbx-mounts-"));
  const sandboxRoot = path.join(stateDir, "sandbox");
  const agentRoot = path.join(stateDir, "agent");
  await fs.mkdir(sandboxRoot, { recursive: true });
  await fs.mkdir(agentRoot, { recursive: true });
  const bridge = createUnsafeMountedBridge({ root: sandboxRoot, agentHostRoot: agentRoot });
  const sandbox = createSandbox({ sandboxRoot, agentRoot, fsBridge: bridge });
  try {
    await run({ sandboxRoot, agentRoot, sandbox });
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("tools.fs.workspaceOnly", () => {
  it("defaults to allowing sandbox mounts outside the workspace root", async () => {
    await withUnsafeMountedSandboxHarness(async ({ sandboxRoot, agentRoot, sandbox }) => {
      await fs.writeFile(path.join(agentRoot, "secret.txt"), "shh", "utf8");

      const tools = createOpenClawCodingTools({ sandbox, workspaceDir: sandboxRoot });
      const { readTool, writeTool } = expectReadWriteTools(tools);

      const readResult = await readTool?.execute("t1", { path: "/agent/secret.txt" });
      expect(getTextContent(readResult)).toContain("shh");

      await writeTool?.execute("t2", { path: "/agent/owned.txt", content: "x" });
      expect(await fs.readFile(path.join(agentRoot, "owned.txt"), "utf8")).toBe("x");
    });
  });

  it("rejects sandbox mounts outside the workspace root when enabled", async () => {
    await withUnsafeMountedSandboxHarness(async ({ sandboxRoot, agentRoot, sandbox }) => {
      await fs.writeFile(path.join(agentRoot, "secret.txt"), "shh", "utf8");

      const cfg = { tools: { fs: { workspaceOnly: true } } } as unknown as OpenClawConfig;
      const tools = createOpenClawCodingTools({ sandbox, workspaceDir: sandboxRoot, config: cfg });
      const { readTool, writeTool, editTool } = expectReadWriteEditTools(tools);

      await expect(readTool?.execute("t1", { path: "/agent/secret.txt" })).rejects.toThrow(
        /Path escapes sandbox root/i,
      );

      await expect(
        writeTool?.execute("t2", { path: "/agent/owned.txt", content: "x" }),
      ).rejects.toThrow(/Path escapes sandbox root/i);
      await expect(fs.stat(path.join(agentRoot, "owned.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      await expect(
        editTool?.execute("t3", { path: "/agent/secret.txt", oldText: "shh", newText: "nope" }),
      ).rejects.toThrow(/Path escapes sandbox root/i);
      expect(await fs.readFile(path.join(agentRoot, "secret.txt"), "utf8")).toBe("shh");
    });
  });
});
