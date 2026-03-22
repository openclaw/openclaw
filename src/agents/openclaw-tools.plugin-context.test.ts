import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./tools/common.js";

const { resolvePluginToolsMock } = vi.hoisted(() => ({
  resolvePluginToolsMock: vi.fn<(params?: unknown) => AnyAgentTool[]>((params?: unknown) => {
    void params;
    return [];
  }),
}));

vi.mock("../plugins/tools.js", () => ({
  resolvePluginTools: resolvePluginToolsMock,
  getPluginToolMeta: vi.fn(() => undefined),
}));

import { createOpenClawTools } from "./openclaw-tools.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

describe("createOpenClawTools plugin context", () => {
  beforeEach(() => {
    resolvePluginToolsMock.mockClear();
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

  it("injects messageThreadId from agentThreadId when tool schema supports messageThreadId", async () => {
    const executeMock = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    }));
    const threadTool: AnyAgentTool = {
      name: "plugin-message-thread-test",
      label: "plugin-message-thread-test",
      description: "test",
      ownerOnly: false,
      parameters: {
        type: "object",
        properties: { messageThreadId: { type: "number" } },
      },
      execute: executeMock,
    };

    resolvePluginToolsMock.mockReturnValue([threadTool]);

    const tools = createOpenClawTools({
      config: {} as never,
      agentThreadId: 77,
    });
    const tool = tools.find((candidate) => candidate.name === threadTool.name);
    expect(tool).toBeDefined();
    if (!tool) {
      return;
    }

    expect(tool).toBe(threadTool);
    await tool.execute("call1", {});
    expect(executeMock).toHaveBeenCalledWith("call1", { messageThreadId: 77 });
  });

  it("does not override explicit params.messageThreadId provided by the caller", async () => {
    const executeMock = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    }));
    const threadTool: AnyAgentTool = {
      name: "plugin-message-thread-test-override",
      label: "plugin-message-thread-test-override",
      description: "test",
      ownerOnly: false,
      parameters: {
        type: "object",
        properties: { messageThreadId: { type: "number" } },
      },
      execute: executeMock,
    };

    resolvePluginToolsMock.mockReturnValue([threadTool]);

    const tools = createOpenClawTools({
      config: {} as never,
      agentThreadId: 77,
    });
    const tool = tools.find((candidate) => candidate.name === threadTool.name);
    expect(tool).toBeDefined();
    if (!tool) {
      return;
    }

    expect(tool).toBe(threadTool);
    await tool.execute("call1", { messageThreadId: 5 });
    expect(executeMock).toHaveBeenCalledWith("call1", { messageThreadId: 5 });
  });

  it("does not override explicit params.message_thread_id provided by the caller", async () => {
    const executeMock = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    }));
    const threadTool: AnyAgentTool = {
      name: "plugin-message-thread-test-snake-override",
      label: "plugin-message-thread-test-snake-override",
      description: "test",
      ownerOnly: false,
      parameters: {
        type: "object",
        properties: { messageThreadId: { type: "number" } },
      },
      execute: executeMock,
    };

    resolvePluginToolsMock.mockReturnValue([threadTool]);

    const tools = createOpenClawTools({
      config: {} as never,
      agentThreadId: 77,
    });
    const tool = tools.find((candidate) => candidate.name === threadTool.name);
    expect(tool).toBeDefined();
    if (!tool) {
      return;
    }

    expect(tool).toBe(threadTool);
    await tool.execute("call1", { message_thread_id: 5 });
    expect(executeMock).toHaveBeenCalledWith("call1", { message_thread_id: 5 });
  });

  it("preserves large integer string agentThreadId as string (snowflake-safe injection)", async () => {
    const snowflake = "1177378744822943744";
    const executeMock = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    }));
    const threadTool: AnyAgentTool = {
      name: "plugin-message-thread-snowflake",
      label: "plugin-message-thread-snowflake",
      description: "test",
      ownerOnly: false,
      parameters: {
        type: "object",
        properties: { messageThreadId: { type: "string" } },
      },
      execute: executeMock,
    };

    resolvePluginToolsMock.mockReturnValue([threadTool]);

    const tools = createOpenClawTools({
      config: {} as never,
      agentThreadId: snowflake,
    });
    const tool = tools.find((candidate) => candidate.name === threadTool.name);
    expect(tool).toBeDefined();
    if (!tool) {
      return;
    }

    await tool.execute("call1", {});
    expect(executeMock).toHaveBeenCalledWith("call1", { messageThreadId: snowflake });
  });

  it("coerces small numeric string agentThreadId into a number before injecting messageThreadId", async () => {
    const executeMock = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    }));
    const threadTool: AnyAgentTool = {
      name: "plugin-message-thread-test-string",
      label: "plugin-message-thread-test-string",
      description: "test",
      ownerOnly: false,
      parameters: {
        type: "object",
        properties: { messageThreadId: { type: "number" } },
      },
      execute: executeMock,
    };

    resolvePluginToolsMock.mockReturnValue([threadTool]);

    const tools = createOpenClawTools({
      config: {} as never,
      agentThreadId: "77",
    });
    const tool = tools.find((candidate) => candidate.name === threadTool.name);
    expect(tool).toBeDefined();
    if (!tool) {
      return;
    }

    expect(tool).toBe(threadTool);
    await tool.execute("call1", {});
    expect(executeMock).toHaveBeenCalledWith("call1", { messageThreadId: 77 });
  });
});
