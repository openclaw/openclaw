import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { createReefOwnerNoticeHandler } from "./owner-notice.js";

describe("createReefOwnerNoticeHandler", () => {
  it("queues a rejection in the peer session and wakes that agent", async () => {
    const runtime = createPluginRuntimeMock();
    vi.mocked(runtime.channel.routing.resolveAgentRoute).mockReturnValue({
      agentId: "main",
      accountId: "default",
      sessionKey: "agent:main:reef:direct:alice",
    });
    vi.mocked(runtime.system.enqueueSystemEvent).mockReturnValue(true);
    const notify = createReefOwnerNoticeHandler({
      runtime,
      cfg: {},
      accountId: "default",
      handle: "bob",
    });

    await notify({
      text: "delivery rejected",
      peer: "alice",
      contextKey: "reef:delivery-rejected:01jz0000000000000000000105",
      wakeAgent: true,
    });

    expect(runtime.channel.routing.resolveAgentRoute).toHaveBeenCalledWith({
      cfg: {},
      channel: "reef",
      accountId: "default",
      peer: { kind: "direct", id: "alice" },
    });
    expect(runtime.system.enqueueSystemEvent).toHaveBeenCalledWith("delivery rejected", {
      sessionKey: "agent:main:reef:direct:alice",
      contextKey: "reef:delivery-rejected:01jz0000000000000000000105",
    });
    expect(runtime.system.requestHeartbeat).toHaveBeenCalledWith({
      source: "other",
      intent: "immediate",
      reason: "reef:delivery-rejected",
      agentId: "main",
      sessionKey: "agent:main:reef:direct:alice",
    });
  });

  it("does not wake when the same notice is already queued", async () => {
    const runtime = createPluginRuntimeMock();
    vi.mocked(runtime.system.enqueueSystemEvent).mockReturnValue(false);
    const notify = createReefOwnerNoticeHandler({
      runtime,
      cfg: {},
      accountId: "default",
      handle: "bob",
    });

    await notify({
      text: "delivery rejected",
      contextKey: "reef:delivery-rejected:01jz0000000000000000000105",
      wakeAgent: true,
    });

    expect(runtime.system.requestHeartbeat).not.toHaveBeenCalled();
  });
});
