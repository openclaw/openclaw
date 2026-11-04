import { describe, expect, it } from "vitest";
import { prepareSpawnThreadBinding } from "./spawn-plan.js";
import { buildSpawnThreadBinding } from "./subagents/spawn/spawn-thread-binding.js";

describe("thread-bound spawn source message", () => {
  it("hands the requester's inbound message to the child-placement bind", async () => {
    const prepared = await prepareSpawnThreadBinding({
      cfg: {},
      kind: "subagent",
      mode: "session",
      bindingService: {
        getCapabilities: () => ({
          adapterAvailable: true,
          bindSupported: true,
          unbindSupported: true,
          placements: ["child"],
        }),
        listBySession: async () => [],
      },
      requesterSessionKey: "agent:main:mattermost:channel:chan-1",
      channel: "mattermost",
      accountId: "default",
      to: "channel:chan-1",
      sourceMessageId: "post-1",
    });
    if (!prepared.ok) {
      throw new Error(prepared.error);
    }

    expect(
      buildSpawnThreadBinding({
        cfg: {},
        sessionKey: "agent:main:subagent:child",
        targetKind: "subagent",
        agentId: "main",
        binding: prepared.binding,
      }),
    ).toMatchObject({
      placement: "child",
      sourceMessageId: "post-1",
      conversation: { channel: "mattermost", conversationId: "chan-1" },
    });
  });
});
