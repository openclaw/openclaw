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

  it("injects DevClaw topicId from agentThreadId when tool schema supports topicId", async () => {
    const topicIdTool: AnyAgentTool = {
      name: "devclaw-topicId-test",
      label: "devclaw-topicId-test",
      description: "test",
      ownerOnly: false,
      parameters: {
        type: "object",
        properties: { topicId: { type: "number" } },
      },
      execute: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      })),
    };

    resolvePluginToolsMock.mockReturnValue([topicIdTool]);

    const tools = createOpenClawTools({
      config: {} as never,
      agentThreadId: 77,
    });
    const tool = tools.find((candidate) => candidate.name === topicIdTool.name);
    expect(tool).toBeDefined();
    if (!tool) {
      return;
    }

    await tool.execute("call1", {});
    expect(topicIdTool.execute).toHaveBeenCalledWith("call1", { topicId: 77 });
  });

  it("does not override explicit params.topicId provided by the caller", async () => {
    const topicIdTool: AnyAgentTool = {
      name: "devclaw-topicId-test-override",
      label: "devclaw-topicId-test-override",
      description: "test",
      ownerOnly: false,
      parameters: {
        type: "object",
        properties: { topicId: { type: "number" } },
      },
      execute: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      })),
    };

    resolvePluginToolsMock.mockReturnValue([topicIdTool]);

    const tools = createOpenClawTools({
      config: {} as never,
      agentThreadId: 77,
    });
    const tool = tools.find((candidate) => candidate.name === topicIdTool.name);
    expect(tool).toBeDefined();
    if (!tool) {
      return;
    }

    await tool.execute("call1", { topicId: 5 });
    expect(topicIdTool.execute).toHaveBeenCalledWith("call1", { topicId: 5 });
  });

  it("coerces numeric string agentThreadId into a number before injecting", async () => {
    const topicIdTool: AnyAgentTool = {
      name: "devclaw-topicId-test-string",
      label: "devclaw-topicId-test-string",
      description: "test",
      ownerOnly: false,
      parameters: {
        type: "object",
        properties: { topicId: { type: "number" } },
      },
      execute: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      })),
    };

    resolvePluginToolsMock.mockReturnValue([topicIdTool]);

    const tools = createOpenClawTools({
      config: {} as never,
      agentThreadId: "77",
    });
    const tool = tools.find((candidate) => candidate.name === topicIdTool.name);
    expect(tool).toBeDefined();
    if (!tool) {
      return;
    }

    await tool.execute("call1", {});
    expect(topicIdTool.execute).toHaveBeenCalledWith("call1", { topicId: 77 });
  });
});
