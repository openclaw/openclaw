import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { wrapToolWorkspaceRootGuardWithOptions, wrapToolWritePathPolicyGuard } from "./pi-tools.read.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

const mocks = vi.hoisted(() => ({
  assertSandboxPath: vi.fn(async () => ({ resolved: "/tmp/root", relative: "" })),
}));

vi.mock("./sandbox-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sandbox-paths.js")>();
  return {
    ...actual,
    assertSandboxPath: mocks.assertSandboxPath,
  };
});

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

describe("wrapToolWorkspaceRootGuardWithOptions", () => {
  const root = "/tmp/root";

  beforeEach(() => {
    mocks.assertSandboxPath.mockClear();
  });

  it("maps container workspace paths to host workspace root", async () => {
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

  it("maps @-prefixed container workspace paths to host workspace root", async () => {
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

describe("wrapToolWritePathPolicyGuard", () => {
  const root = "/tmp/root";

  it("allows writes mapped under an allowed container workspace path", async () => {
    const { execute, tool } = createToolHarness();
    const wrapped = wrapToolWritePathPolicyGuard(
      tool,
      root,
      { allow: ["docs/**"] },
      { containerWorkdir: "/workspace" },
    );

    await wrapped.execute("tc-allow", { path: "/workspace/docs/readme.md", content: "ok" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects writes outside allow patterns after container-path remap", async () => {
    const { execute, tool } = createToolHarness();
    const wrapped = wrapToolWritePathPolicyGuard(
      tool,
      root,
      { allow: ["docs/**"] },
      { containerWorkdir: "/workspace" },
    );

    await expect(
      wrapped.execute("tc-deny-allow", { path: "/workspace/secrets.txt", content: "no" }),
    ).rejects.toThrow(/not allowed by cron payload\.paths\.allow/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("applies deny patterns before allow patterns", async () => {
    const { execute, tool } = createToolHarness();
    const wrapped = wrapToolWritePathPolicyGuard(tool, root, {
      allow: ["docs/**"],
      deny: ["docs/private/**"],
    });

    await expect(
      wrapped.execute("tc-deny-first", { path: "docs/private/notes.md", content: "no" }),
    ).rejects.toThrow(/payload\.paths\.deny pattern/i);
    expect(execute).not.toHaveBeenCalled();
  });
});
