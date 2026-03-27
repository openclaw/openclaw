import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
