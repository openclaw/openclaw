// Canvas tests cover index plugin behavior.
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import canvasPlugin from "./index.js";

const mocks = vi.hoisted(() => {
  const httpHandler = {
    handleHttpRequest: vi.fn(async () => true),
  };
  const toolExecute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
  return {
    httpHandler,
    loadRenderer: vi.fn(),
    createDefaultCanvasCliDependencies: vi.fn(() => ({ deps: true })),
    registerNodesCanvasCommands: vi.fn(),
    toolExecute,
    createCanvasTool: vi.fn(() => ({
      label: "Canvas",
      name: "canvas",
      description: "Canvas",
      parameters: {},
      execute: toolExecute,
    })),
  };
});

vi.mock("./src/host/a2ui.js", () => {
  mocks.loadRenderer();
  return { handleA2uiHttpRequest: mocks.httpHandler.handleHttpRequest };
});

vi.mock("./src/cli.js", () => ({
  createDefaultCanvasCliDependencies: mocks.createDefaultCanvasCliDependencies,
  registerNodesCanvasCommands: mocks.registerNodesCanvasCommands,
}));

vi.mock("./src/tool.js", () => ({
  createCanvasTool: mocks.createCanvasTool,
}));

function registerCanvas(config: OpenClawPluginApi["config"] = {}) {
  const registrations = {
    registerHttpRoute: vi.fn<OpenClawPluginApi["registerHttpRoute"]>(),
    registerService: vi.fn<OpenClawPluginApi["registerService"]>(),
    registerHostedMediaResolver: vi.fn<OpenClawPluginApi["registerHostedMediaResolver"]>(),
    registerWidgetPresenter: vi.fn<OpenClawPluginApi["registerWidgetPresenter"]>(),
    registerTool: vi.fn<OpenClawPluginApi["registerTool"]>(),
    registerNodeCliFeature: vi.fn<OpenClawPluginApi["registerNodeCliFeature"]>(),
    registerNodeInvokePolicy: vi.fn<OpenClawPluginApi["registerNodeInvokePolicy"]>(),
    registerBoardWidgetContentKind: vi.fn<OpenClawPluginApi["registerBoardWidgetContentKind"]>(),
  };
  canvasPlugin.register?.(
    createTestPluginApi({ id: "canvas", name: "Canvas", config, ...registrations }),
  );
  return {
    routes: registrations.registerHttpRoute.mock.calls.map(([route]) => route),
    services: registrations.registerService.mock.calls,
    resolvers: registrations.registerHostedMediaResolver.mock.calls,
    widgetPresenters: registrations.registerWidgetPresenter.mock.calls.map(
      ([presenter]) => presenter,
    ),
    tools: registrations.registerTool.mock.calls.map(([tool, opts]) => ({ tool, opts })),
    cliFeatures: registrations.registerNodeCliFeature.mock.calls.map(([registrar, opts]) => ({
      registrar,
      opts,
    })),
    nodeInvokePolicies: registrations.registerNodeInvokePolicy.mock.calls.map(([policy]) => policy),
    boardWidgetContentKinds: registrations.registerBoardWidgetContentKind.mock.calls.map(
      ([kind]) => kind,
    ),
  };
}

describe("Canvas plugin entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the macOS-only presenter surface and command policy", () => {
    const { boardWidgetContentKinds, nodeInvokePolicies, routes, widgetPresenters } =
      registerCanvas();

    expect(nodeInvokePolicies[0]).toMatchObject({
      commands: ["canvas.present", "canvas.hide", "canvas.navigate"],
      defaultPlatforms: ["macos"],
    });
    expect(routes).toEqual([
      expect.objectContaining({ path: "/__openclaw__/a2ui", match: "prefix" }),
    ]);
    expect(boardWidgetContentKinds).toEqual([
      expect.objectContaining({ kind: "a2ui", label: "A2UI" }),
    ]);
    expect(widgetPresenters).toEqual([
      expect.objectContaining({
        target: "node_panel",
        description: "Show on a connected device panel",
        availability: expect.any(Function),
        present: expect.any(Function),
      }),
    ]);
  });

  it("uses host.enabled as the single presenter and hosted-resource gate", () => {
    const { boardWidgetContentKinds, routes, widgetPresenters } = registerCanvas({
      plugins: { entries: { canvas: { config: { host: { enabled: false } } } } },
    });

    expect(boardWidgetContentKinds).toEqual([]);
    expect(routes).toEqual([]);
    expect(widgetPresenters).toEqual([]);
  });

  it("defers A2UI asset implementation until the route is used", async () => {
    const { routes, services } = registerCanvas();

    expect(routes).toHaveLength(1);
    expect(services).toHaveLength(0);
    expect(mocks.loadRenderer).not.toHaveBeenCalled();

    const request = new IncomingMessage(new Socket());
    request.url = "/__openclaw__/a2ui/a2ui.bundle.js";
    await routes[0]?.handler(request, new ServerResponse(request));
    expect(mocks.loadRenderer).toHaveBeenCalledTimes(1);
    expect(mocks.httpHandler.handleHttpRequest).toHaveBeenCalledTimes(1);
  });

  it("defers Canvas CLI and tool implementations until use", async () => {
    const { resolvers, tools, cliFeatures } = registerCanvas();

    expect(resolvers).toHaveLength(0);
    expect(tools).toHaveLength(1);
    expect(tools.map(({ opts }) => opts?.name)).toEqual([undefined]);
    expect(cliFeatures).toHaveLength(1);
    expect(mocks.createDefaultCanvasCliDependencies).not.toHaveBeenCalled();
    expect(mocks.createCanvasTool).not.toHaveBeenCalled();

    await cliFeatures[0]?.registrar({
      program: {} as never,
      parentPath: ["nodes"],
      config: {},
      workspaceDir: undefined,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    expect(mocks.createDefaultCanvasCliDependencies).toHaveBeenCalledTimes(1);
    expect(mocks.registerNodesCanvasCommands).toHaveBeenCalledTimes(1);

    const registeredTools = tools.map(({ tool: toolFactory }) => {
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
      return tool as AnyAgentTool;
    });
    expect(registeredTools.map((tool) => tool.name)).toEqual(["canvas"]);
    expect(registeredTools.map((tool) => tool.resultContentSource)).toEqual(["network"]);
    expect(mocks.createCanvasTool).not.toHaveBeenCalled();

    const [canvasTool] = registeredTools;
    await canvasTool?.execute("tool-call", { action: "hide" });
    expect(mocks.createCanvasTool).toHaveBeenCalledWith({
      agentSessionKey: "agent:main:canvas",
    });
    expect(mocks.toolExecute).toHaveBeenCalledWith("tool-call", { action: "hide" });
  });
});
