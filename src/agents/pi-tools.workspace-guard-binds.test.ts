import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { wrapToolWorkspaceRootGuard } from "./pi-tools.read.js";

function createStubTool(): AnyAgentTool {
  return {
    name: "read",
    description: "read a file",
    parameters: {},
    execute: async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }),
  } as unknown as AnyAgentTool;
}

describe("wrapToolWorkspaceRootGuard with bind mount roots (#16379)", () => {
  const root = "/tmp/workspace-one";
  const bindRoot = "/tmp/workspace-two";

  it("allows paths within the primary workspace root", async () => {
    const tool = wrapToolWorkspaceRootGuard(createStubTool(), root);
    const result = await tool.execute("t1", { path: path.join(root, "file.txt") });
    expect(result).toBeDefined();
  });

  it("rejects paths outside all roots when no additional roots", async () => {
    const tool = wrapToolWorkspaceRootGuard(createStubTool(), root);
    await expect(tool.execute("t1", { path: "/etc/passwd" })).rejects.toThrow(
      /Path escapes sandbox root/,
    );
  });

  it("allows paths within bind mount roots when additionalRoots is set", async () => {
    const tool = wrapToolWorkspaceRootGuard(createStubTool(), root, {
      additionalRoots: [bindRoot],
    });
    const result = await tool.execute("t1", { path: path.join(bindRoot, "file.txt") });
    expect(result).toBeDefined();
  });

  it("still rejects paths outside all roots even with additionalRoots", async () => {
    const tool = wrapToolWorkspaceRootGuard(createStubTool(), root, {
      additionalRoots: [bindRoot],
    });
    await expect(tool.execute("t1", { path: "/etc/passwd" })).rejects.toThrow(
      /Path escapes sandbox root/,
    );
  });

  it("allows paths within any of multiple additional roots", async () => {
    const bindRoot2 = "/tmp/workspace-three";
    const tool = wrapToolWorkspaceRootGuard(createStubTool(), root, {
      additionalRoots: [bindRoot, bindRoot2],
    });
    const result = await tool.execute("t1", { path: path.join(bindRoot2, "doc.md") });
    expect(result).toBeDefined();
  });
});
