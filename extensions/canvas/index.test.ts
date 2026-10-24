import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import canvasPlugin from "./index.js";

const mocks = vi.hoisted(() => {
  const toolExecute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
  return {
    handleHttpRequest: vi.fn(async () => true),
    loadRenderer: vi.fn(),
    registerNodesCanvasCommands: vi.fn(),
    toolExecute,
    createCanvasTool: vi.fn(() => ({ execute: toolExecute })),
  };
});

// mock-isolation: the real renderer must stay unloaded until the HTTP route is used.
vi.mock("./src/host/a2ui.js", () => {
  mocks.loadRenderer();
  return { handleA2uiHttpRequest: mocks.handleHttpRequest };
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
    registerBoardWidgetContentKind: vi.fn<OpenClawPluginApi["registerBoardWidgetContentKind"]>(),
  };
  canvasPlugin.register?.(
    createTestPluginApi({ id: "canvas", name: "Canvas", config, ...registrations }),
  );
  return registrations;
}

describe("Canvas plugin entry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers the macOS-only presenter surface and command policy", () => {
    const api = registerCanvas();
    const [policy] = api.registerNodeInvokePolicy.mock.calls;
    assert(policy);
    expect(policy[0]).toMatchObject({
      commands: ["canvas.present", "canvas.hide", "canvas.navigate"],
      defaultPlatforms: ["macos"],
    });
    expect(api.registerHttpRoute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ path: "/__openclaw__/a2ui", match: "prefix" }),
    );
    expect(api.registerBoardWidgetContentKind).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "a2ui", label: "A2UI" }),
    );
    expect(api.registerWidgetPresenter).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        target: "node_panel",
        description: "Show on a connected device panel",
        availability: expect.any(Function),
        present: expect.any(Function),
      }),
    );
  });

  it("uses host.enabled as the single presenter and hosted-resource gate", () => {
    const api = registerCanvas({
      plugins: { entries: { canvas: { config: { host: { enabled: false } } } } },
    });
    expect(api.registerBoardWidgetContentKind).not.toHaveBeenCalled();
    expect(api.registerHttpRoute).not.toHaveBeenCalled();
    expect(api.registerWidgetPresenter).not.toHaveBeenCalled();
  });

  it("defers A2UI asset implementation until the route is used", async () => {
    const api = registerCanvas();
    expect(api.registerService).not.toHaveBeenCalled();
    expect(mocks.loadRenderer).not.toHaveBeenCalled();

    const request = new IncomingMessage(new Socket());
    request.url = "/__openclaw__/a2ui/a2ui.bundle.js";
    const [route] = api.registerHttpRoute.mock.calls;
    assert(route);
    await route[0].handler(request, new ServerResponse(request));
    expect(mocks.loadRenderer).toHaveBeenCalledTimes(1);
    expect(mocks.handleHttpRequest).toHaveBeenCalledTimes(1);
  });

  it("defers Canvas CLI and tool implementations until use", async () => {
    const api = registerCanvas();
    expect(api.registerTool).toHaveBeenCalledTimes(1);
    const [toolRegistration] = api.registerTool.mock.calls;
    assert(toolRegistration);
    const [toolFactory, opts] = toolRegistration;
    expect(opts?.name).toBeUndefined();
    expect(api.registerNodeCliFeature).toHaveBeenCalledTimes(1);
    expect(mocks.registerNodesCanvasCommands).not.toHaveBeenCalled();
    expect(mocks.createCanvasTool).not.toHaveBeenCalled();
    const [cliRegistration] = api.registerNodeCliFeature.mock.calls;
    assert(cliRegistration);
    await cliRegistration[0]({
      program: {} as never,
      parentPath: ["nodes"],
      config: {},
      workspaceDir: undefined,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    expect(mocks.registerNodesCanvasCommands).toHaveBeenCalledTimes(1);
    if (typeof toolFactory !== "function") {
      throw new Error("expected legacy canvas factory");
    }
    const tool = toolFactory({
      config: {},
      workspaceDir: "/tmp/workspace",
      sessionKey: "agent:main:canvas",
      sessionId: "session-1",
      agentId: "agent-1",
    });
    expect(Array.isArray(tool)).toBe(false);
    expect(tool).toMatchObject({ name: "canvas", resultContentSource: "network" });
    expect(mocks.createCanvasTool).not.toHaveBeenCalled();
    await (tool as AnyAgentTool).execute("tool-call", { action: "hide" });
    expect(mocks.createCanvasTool).toHaveBeenCalledWith({ agentSessionKey: "agent:main:canvas" });
    expect(mocks.toolExecute).toHaveBeenCalledWith("tool-call", { action: "hide" });
  });
});
