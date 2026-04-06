import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-core-tools.js";

const mocks = vi.hoisted(() => {
  const nodesTool = {
    name: "nodes",
    description: "nodes stub",
    parameters: { type: "object", properties: {} },
    ownerOnly: true,
    execute: vi.fn(),
  };
  const wrappedNodesTool = {
    ...nodesTool,
    description: "wrapped nodes stub",
  };
  return {
    createNodesTool: vi.fn(() => nodesTool),
    wrapToolWorkspaceRootGuardWithOptions: vi.fn(() => wrappedNodesTool),
    nodesTool,
    wrappedNodesTool,
  };
});

vi.mock("./tools/nodes-tool.js", () => ({
  createNodesTool: mocks.createNodesTool,
}));

vi.mock("./pi-tools.read.js", async () => {
  const actual = await vi.importActual<typeof import("./pi-tools.read.js")>("./pi-tools.read.js");
  return {
    ...actual,
    wrapToolWorkspaceRootGuardWithOptions: mocks.wrapToolWorkspaceRootGuardWithOptions,
  };
});

let createOpenClawTools: typeof import("./openclaw-tools.js").createOpenClawTools;

describe("createOpenClawTools nodes workspaceOnly guard", () => {
  beforeAll(async () => {
    ({ createOpenClawTools } = await import("./openclaw-tools.js"));
  });

  beforeEach(() => {
    mocks.createNodesTool.mockClear();
    mocks.wrapToolWorkspaceRootGuardWithOptions.mockClear();
  });

  it("wraps nodes with workspace guards for outPath when workspaceOnly is enabled", () => {
    const tools = createOpenClawTools({
      workspaceDir: "/tmp/workspace",
      containerWorkdir: "/workspace",
      fsPolicy: { workspaceOnly: true },
      disablePluginTools: true,
    });

    expect(mocks.wrapToolWorkspaceRootGuardWithOptions).toHaveBeenCalledWith(
      mocks.nodesTool,
      "/tmp/workspace",
      {
        containerWorkdir: "/workspace",
        pathParamNames: ["outPath"],
      },
    );
    expect(tools.find((tool) => tool.name === "nodes")).toBe(mocks.wrappedNodesTool);
  });

  it("leaves nodes unwrapped when workspaceOnly is disabled", () => {
    const tools = createOpenClawTools({
      workspaceDir: "/tmp/workspace",
      fsPolicy: { workspaceOnly: false },
      disablePluginTools: true,
    });

    expect(mocks.wrapToolWorkspaceRootGuardWithOptions).not.toHaveBeenCalled();
    expect(tools.find((tool) => tool.name === "nodes")).toBe(mocks.nodesTool);
  });
});
