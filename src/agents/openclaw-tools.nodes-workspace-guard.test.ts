import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./tools/common.js";

const mocks = vi.hoisted(() => ({
  assertSandboxPath: vi.fn(async (params: { filePath: string; cwd: string; root: string }) => {
    const root = params.root.replace(/\/+$/, "");
    const filePath = params.filePath;
    const inside = filePath === root || filePath.startsWith(`${root}/`);
    if (!inside) {
      throw new Error(`Path escapes sandbox root (${root}): ${filePath}`);
    }
    const relative = filePath === root ? "" : filePath.slice(root.length + 1);
    return { resolved: filePath, relative };
  }),
  nodesExecute: vi.fn(async () => ({
    content: [{ type: "text", text: "ok" }],
  })),
}));

vi.mock("./sandbox-paths.js", () => ({
  assertSandboxPath: mocks.assertSandboxPath,
}));

vi.mock("./tools/nodes-tool.js", () => ({
  createNodesTool: () =>
    ({
      name: "nodes",
      label: "Nodes",
      description: "nodes test tool",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: mocks.nodesExecute,
    }) as AnyAgentTool,
}));

let createOpenClawTools: typeof import("./openclaw-tools.js").createOpenClawTools;

const WORKSPACE_ROOT = "/tmp/openclaw-workspace-nodes-guard";

describe("createOpenClawTools nodes workspace guard", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ createOpenClawTools } = await import("./openclaw-tools.js"));
  });

  beforeEach(() => {
    mocks.assertSandboxPath.mockClear();
    mocks.nodesExecute.mockClear();
  });

  function getNodesTool(workspaceOnly: boolean): AnyAgentTool {
    const tools = createOpenClawTools({
      workspaceDir: WORKSPACE_ROOT,
      fsPolicy: { workspaceOnly },
      disablePluginTools: true,
      disableMessageTool: true,
    });
    const nodesTool = tools.find((tool) => tool.name === "nodes");
    expect(nodesTool).toBeDefined();
    if (!nodesTool) {
      throw new Error("missing nodes tool");
    }
    return nodesTool;
  }

  it("guards outPath when workspaceOnly is enabled", async () => {
    const nodesTool = getNodesTool(true);
    await nodesTool.execute("call-1", {
      action: "screen_record",
      outPath: `${WORKSPACE_ROOT}/videos/capture.mp4`,
    });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      filePath: `${WORKSPACE_ROOT}/videos/capture.mp4`,
      cwd: WORKSPACE_ROOT,
      root: WORKSPACE_ROOT,
    });
    expect(mocks.nodesExecute).toHaveBeenCalledTimes(1);
  });

  it("rejects outPath outside workspace when workspaceOnly is enabled", async () => {
    const nodesTool = getNodesTool(true);
    await expect(
      nodesTool.execute("call-2", {
        action: "screen_record",
        outPath: "/etc/passwd",
      }),
    ).rejects.toThrow(/Path escapes sandbox root/);

    expect(mocks.assertSandboxPath).toHaveBeenCalledTimes(1);
    expect(mocks.nodesExecute).not.toHaveBeenCalled();
  });

  it("does not guard outPath when workspaceOnly is disabled", async () => {
    const nodesTool = getNodesTool(false);
    await nodesTool.execute("call-3", {
      action: "screen_record",
      outPath: "/etc/passwd",
    });

    expect(mocks.assertSandboxPath).not.toHaveBeenCalled();
    expect(mocks.nodesExecute).toHaveBeenCalledTimes(1);
  });
});
