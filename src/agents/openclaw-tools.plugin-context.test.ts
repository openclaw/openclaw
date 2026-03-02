import { describe, expect, it, vi } from "vitest";

const resolvePluginToolsMock = vi.fn((_params: unknown) => []);

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
});
