import { beforeEach, describe, expect, it, vi } from "vitest";
import { setDefaultChannelPluginRegistryForTests } from "../../../src/commands/channel-test-helpers.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import {
  __testing as sessionBindingTesting,
  registerSessionBindingAdapter,
} from "../../../src/infra/outbound/session-binding-service.js";
import { resolveBlueBubblesConversationRoute } from "./conversation-route.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    list: [{ id: "main" }, { id: "codex" }],
  },
} satisfies OpenClawConfig;

describe("resolveBlueBubblesConversationRoute", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    setDefaultChannelPluginRegistryForTests();
  });

  it("lets runtime BlueBubbles conversation bindings override default routing", () => {
    const touch = vi.fn();
    registerSessionBindingAdapter({
      channel: "bluebubbles",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "+15555550123"
          ? {
              bindingId: "default:+15555550123",
              targetSessionKey: "agent:codex:acp:bound-1",
              targetKind: "session",
              conversation: {
                channel: "bluebubbles",
                accountId: "default",
                conversationId: "+15555550123",
              },
              status: "active",
              boundAt: Date.now(),
              metadata: { boundBy: "user-1" },
            }
          : null,
      touch,
    });

    const route = resolveBlueBubblesConversationRoute({
      cfg: baseCfg,
      accountId: "default",
      isGroup: false,
      peerId: "+15555550123",
      sender: "+15555550123",
    });

    expect(route.agentId).toBe("codex");
    expect(route.sessionKey).toBe("agent:codex:acp:bound-1");
    expect(route.matchedBy).toBe("binding.channel");
    expect(touch).toHaveBeenCalledWith("default:+15555550123", undefined);
  });
});
