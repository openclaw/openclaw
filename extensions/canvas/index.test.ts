import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import canvasPlugin from "./index.js";

const mocks = vi.hoisted(() => {
  const toolExecute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
  return {
    registerNodesCanvasCommands: vi.fn(),
    toolExecute,
    createCanvasTool: vi.fn(() => ({ execute: toolExecute })),
  };
});

vi.mock("./src/cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/cli.js")>()),
  registerNodesCanvasCommands: mocks.registerNodesCanvasCommands,
}));

// mock-isolation: the real tool must stay unloaded until the lazy execution boundary.
vi.mock("./src/tool.js", () => ({ createCanvasTool: mocks.createCanvasTool }));

// mock-isolation: importing the real harness would defeat the cold-registration guard.
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => {
  throw new Error("agent harness runtime loaded before Canvas presentation");
});

function registerCanvas(config: OpenClawPluginApi["config"] = {}) {
  const registrations = {
    registerHttpRoute: vi.fn<OpenClawPluginApi["registerHttpRoute"]>(),
    registerService: vi.fn<OpenClawPluginApi["registerService"]>(),
    registerWidgetPresenter: vi.fn<OpenClawPluginApi["registerWidgetPresenter"]>(),
    registerTool: vi.fn<OpenClawPluginApi["registerTool"]>(),
    registerNodeCliFeature: vi.fn<OpenClawPluginApi["registerNodeCliFeature"]>(),
    registerNodeInvokePolicy: vi.fn<OpenClawPluginApi["registerNodeInvokePolicy"]>(),
  };
  canvasPlugin.register?.(createTestPluginApi({ config, ...registrations }));
  return registrations;
}

describe("Canvas plugin entry", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([undefined, false])("gates the presenter with host.enabled=%s", (enabled) => {
    const api = registerCanvas(
      enabled === undefined
        ? {}
        : { plugins: { entries: { canvas: { config: { host: { enabled } } } } } },
    );
    expect(api.registerNodeInvokePolicy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        commands: ["canvas.present", "canvas.hide", "canvas.navigate"],
        defaultPlatforms: ["macos"],
      }),
    );
    expect(api.registerHttpRoute).not.toHaveBeenCalled();
    expect(api.registerService).not.toHaveBeenCalled();
    expect(api.registerWidgetPresenter.mock.calls.map(([presenter]) => presenter.target)).toEqual(
      enabled === false ? [] : ["node_panel"],
    );
  });

  it("defers Canvas CLI and tool implementations until use", async () => {
    const api = registerCanvas();
    const toolFactory = api.registerTool.mock.calls[0]?.[0];
    assert(typeof toolFactory === "function");
    expect(mocks.registerNodesCanvasCommands).not.toHaveBeenCalled();
    expect(mocks.createCanvasTool).not.toHaveBeenCalled();
    const registerCli = api.registerNodeCliFeature.mock.calls[0]?.[0];
    assert(registerCli);
    await registerCli({
      program: {} as never,
      parentPath: ["nodes"],
      config: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    expect(mocks.registerNodesCanvasCommands).toHaveBeenCalledTimes(1);
    const tool = toolFactory({ sessionKey: "agent:main:canvas" });
    assert(tool && !Array.isArray(tool));
    expect(tool).toMatchObject({ name: "canvas", resultContentSource: "network" });
    expect(mocks.createCanvasTool).not.toHaveBeenCalled();
    await tool.execute("tool-call", { action: "hide" });
    expect(mocks.createCanvasTool).toHaveBeenCalledWith({ agentSessionKey: "agent:main:canvas" });
    expect(mocks.toolExecute).toHaveBeenCalledWith("tool-call", { action: "hide" });
  });
});
