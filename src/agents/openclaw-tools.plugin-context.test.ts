import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./tools/common.js";

const { resolvePluginToolsMock } = vi.hoisted(() => ({
  resolvePluginToolsMock: vi.fn((params?: unknown) => {
    void params;
    return [];
  }),
}));

vi.mock("../plugins/tools.js", () => ({
  resolvePluginTools: resolvePluginToolsMock,
  copyPluginToolMeta: vi.fn(),
  getPluginToolMeta: vi.fn(() => undefined),
}));

let createOpenClawTools: typeof import("./openclaw-tools.js").createOpenClawTools;
let createOpenClawCodingTools: typeof import("./pi-tools.js").createOpenClawCodingTools;

describe("createOpenClawTools plugin context", () => {
  beforeEach(async () => {
    resolvePluginToolsMock.mockClear();
    vi.resetModules();
    ({ createOpenClawTools } = await import("./openclaw-tools.js"));
    ({ createOpenClawCodingTools } = await import("./pi-tools.js"));
  });

  it("forwards trusted requester sender identity to plugin tool context", () => {
    createOpenClawTools({
      config: {} as never,
      requesterSenderId: "trusted-sender",
      senderIsOwner: true,
    });

    expect(resolvePluginToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          requesterSenderId: "trusted-sender",
          senderIsOwner: true,
        }),
      }),
    );
  });

  it("forwards ephemeral sessionId to plugin tool context", () => {
    createOpenClawTools({
      config: {} as never,
      agentSessionKey: "agent:main:telegram:direct:12345",
      sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });

    expect(resolvePluginToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          sessionKey: "agent:main:telegram:direct:12345",
          sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        }),
      }),
    );
  });

  it("infers the default agent workspace for plugin tools when workspaceDir is omitted", () => {
    const workspaceDir = path.join(process.cwd(), "tmp-main-workspace");
    createOpenClawTools({
      config: {
        agents: {
          defaults: { workspace: workspaceDir },
          list: [{ id: "main", default: true }],
        },
      } as never,
      agentSessionKey: "main",
    });

    expect(resolvePluginToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          agentId: "main",
          workspaceDir,
        }),
      }),
    );
  });

  it("infers the session agent workspace for plugin tools when workspaceDir is omitted", () => {
    const supportWorkspace = path.join(process.cwd(), "tmp-support-workspace");
    createOpenClawTools({
      config: {
        agents: {
          defaults: { workspace: path.join(process.cwd(), "tmp-default-workspace") },
          list: [
            { id: "main", default: true },
            { id: "support", workspace: supportWorkspace },
          ],
        },
      } as never,
      agentSessionKey: "agent:support:main",
    });

    expect(resolvePluginToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          agentId: "support",
          workspaceDir: supportWorkspace,
        }),
      }),
    );
  });

  it("forwards browser session wiring to plugin tool context", () => {
    createOpenClawTools({
      config: {} as never,
      sandboxBrowserBridgeUrl: "http://127.0.0.1:9999",
      allowHostBrowserControl: true,
    });

    expect(resolvePluginToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          browser: {
            sandboxBridgeUrl: "http://127.0.0.1:9999",
            allowHostControl: true,
          },
        }),
      }),
    );
  });

  it("forwards gateway subagent binding for plugin tools", () => {
    createOpenClawTools({
      config: {} as never,
      allowGatewaySubagentBinding: true,
    });

    expect(resolvePluginToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowGatewaySubagentBinding: true,
      }),
    );
  });

  it("forwards gateway subagent binding through coding tools", () => {
    createOpenClawCodingTools({
      config: {} as never,
      allowGatewaySubagentBinding: true,
    });

    expect(resolvePluginToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowGatewaySubagentBinding: true,
      }),
    );
  });

  it("forwards ambient deliveryContext to plugin tool context", () => {
    createOpenClawTools({
      config: {} as never,
      agentChannel: "slack",
      agentTo: "channel:C123",
      agentAccountId: "work",
      agentThreadId: "1710000000.000100",
    });

    expect(resolvePluginToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          deliveryContext: {
            channel: "slack",
            to: "channel:C123",
            accountId: "work",
            threadId: "1710000000.000100",
          },
        }),
      }),
    );
  });

  it("does not inject ambient thread defaults into plugin tools", async () => {
    const executeMock = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    }));
    const sharedTool: AnyAgentTool = {
      name: "plugin-thread-default",
      label: "plugin-thread-default",
      description: "test",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string" },
        },
      },
      execute: executeMock,
    };
    resolvePluginToolsMock.mockImplementation(() => [sharedTool] as never);

    const first = createOpenClawTools({
      config: {} as never,
      agentThreadId: "111.222",
    }).find((tool) => tool.name === "plugin-thread-default");
    const second = createOpenClawTools({
      config: {} as never,
      agentThreadId: "333.444",
    }).find((tool) => tool.name === "plugin-thread-default");

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).toBe(sharedTool);
    expect(second).toBe(sharedTool);

    await first?.execute("call-1", {});
    await second?.execute("call-2", {});

    expect(executeMock).toHaveBeenNthCalledWith(1, "call-1", {});
    expect(executeMock).toHaveBeenNthCalledWith(2, "call-2", {});
  });

  it("does not inject messageThreadId defaults for missing params objects", async () => {
    const executeMock = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    }));
    const tool: AnyAgentTool = {
      name: "plugin-message-thread-default",
      label: "plugin-message-thread-default",
      description: "test",
      parameters: {
        type: "object",
        properties: {
          messageThreadId: { type: "number" },
        },
      },
      execute: executeMock,
    };
    resolvePluginToolsMock.mockReturnValue([tool] as never);

    const wrapped = createOpenClawTools({
      config: {} as never,
      agentThreadId: "77",
    }).find((candidate) => candidate.name === tool.name);

    await wrapped?.execute("call-1", undefined);

    expect(executeMock).toHaveBeenCalledWith("call-1", undefined);
  });

  it("does not infer string thread ids for tools that declare thread parameters", async () => {
    const executeMock = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    }));
    const tool: AnyAgentTool = {
      name: "plugin-string-thread-default",
      label: "plugin-string-thread-default",
      description: "test",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string" },
        },
      },
      execute: executeMock,
    };
    resolvePluginToolsMock.mockReturnValue([tool] as never);

    const wrapped = createOpenClawTools({
      config: {} as never,
      agentThreadId: "77",
    }).find((candidate) => candidate.name === tool.name);

    await wrapped?.execute("call-1", {});

    expect(executeMock).toHaveBeenCalledWith("call-1", {});
  });

  it("preserves explicit thread params when ambient defaults exist", async () => {
    const executeMock = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    }));
    const tool: AnyAgentTool = {
      name: "plugin-thread-override",
      label: "plugin-thread-override",
      description: "test",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string" },
        },
      },
      execute: executeMock,
    };
    resolvePluginToolsMock.mockReturnValue([tool] as never);

    const wrapped = createOpenClawTools({
      config: {} as never,
      agentThreadId: "111.222",
    }).find((candidate) => candidate.name === tool.name);

    await wrapped?.execute("call-1", { threadId: "explicit" });

    expect(executeMock).toHaveBeenCalledWith("call-1", { threadId: "explicit" });
  });
});
