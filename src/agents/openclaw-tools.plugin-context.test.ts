import { describe, expect, it, vi } from "vitest";

const resolvePluginToolsMock = vi.fn(() => []);

vi.mock("../plugins/tools.js", () => ({
  resolvePluginTools: (params: unknown) => resolvePluginToolsMock(params),
}));

import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools plugin context", () => {
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
});
