import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./pi-tools.types.js";

const mocks = vi.hoisted(() => ({
  assertSandboxPath: vi.fn(async () => ({ resolved: "/tmp/root", relative: "" })),
}));

vi.mock("./sandbox-paths.js", () => ({
  assertSandboxPath: mocks.assertSandboxPath,
}));

function createToolHarness() {
  const execute = vi.fn(async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  const tool = {
    name: "read",
    description: "test tool",
    inputSchema: { type: "object", properties: {} },
    execute,
  } as unknown as AnyAgentTool;
  return { execute, tool };
}

async function loadModule() {
  return await import("./pi-tools.read.js");
}

describe("wrapToolWorkspaceRootGuardWithOptions", () => {
  const root = "/tmp/root";

  beforeEach(() => {
    mocks.assertSandboxPath.mockClear();
    vi.resetModules();
  });

  it("maps container workspace paths to host workspace root", async () => {
    const { wrapToolWorkspaceRootGuardWithOptions } = await loadModule();
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc1", { path: "/workspace/docs/readme.md" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      filePath: path.resolve(root, "docs", "readme.md"),
      cwd: root,
      root,
    });
  });

  it("maps file:// container workspace paths to host workspace root", async () => {
    const { wrapToolWorkspaceRootGuardWithOptions } = await loadModule();
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc2", { path: "file:///workspace/docs/readme.md" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      filePath: path.resolve(root, "docs", "readme.md"),
      cwd: root,
      root,
    });
  });

  it("does not remap remote-host file:// paths", async () => {
    const { wrapToolWorkspaceRootGuardWithOptions } = await loadModule();
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc-remote-file-url", { path: "file://attacker/share/readme.md" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      filePath: "file://attacker/share/readme.md",
      cwd: root,
      root,
    });
  });

  it("maps @-prefixed container workspace paths to host workspace root", async () => {
    const { wrapToolWorkspaceRootGuardWithOptions } = await loadModule();
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc-at-container", { path: "@/workspace/docs/readme.md" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      filePath: path.resolve(root, "docs", "readme.md"),
      cwd: root,
      root,
    });
  });

  it("normalizes @-prefixed absolute paths before guard checks", async () => {
    const { wrapToolWorkspaceRootGuardWithOptions } = await loadModule();
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc-at-absolute", { path: "@/etc/passwd" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      filePath: "/etc/passwd",
      cwd: root,
      root,
    });
  });

  it("does not remap absolute paths outside the configured container workdir", async () => {
    const { wrapToolWorkspaceRootGuardWithOptions } = await loadModule();
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc3", { path: "/workspace-two/secret.txt" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      filePath: "/workspace-two/secret.txt",
      cwd: root,
      root,
    });
  });
});
