import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getSessionBindingService,
  resolveRuntimeConversationBindingRouteAsync,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import {
  resolveThreadBindingsEnabled,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { afterEach, beforeEach, expect, it } from "vitest";
import { discordPlugin } from "../channel.js";
import { inspectDiscordConversationRouteOwner } from "../conversation-route-owner.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const cfg: OpenClawConfig = {
  session: { threadBindings: { enabled: false } },
  channels: { discord: { accounts: { work: {} } } },
};

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", source: "test", plugin: discordPlugin }]),
  );
});

afterEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  resetPluginRuntimeStateForTest();
});

it.each([
  {
    kind: "direct" as const,
    peerId: "100000000000000009",
    conversationId: "user:100000000000000009",
  },
  { kind: "channel" as const, peerId: "100000000000000003", conversationId: "100000000000000003" },
])(
  "keeps an unbound $kind route available while thread bindings are disabled",
  async (scenario) => {
    expect(
      resolveThreadBindingsEnabled({
        channelEnabledRaw: undefined,
        sessionEnabledRaw: cfg.session?.threadBindings?.enabled,
      }),
    ).toBe(false);
    const manager = createNoopThreadBindingManager("work");
    try {
      const conversation = {
        channel: "discord",
        accountId: "work",
        conversationId: scenario.conversationId,
      };
      const route = resolveAgentRoute({
        cfg,
        channel: "discord",
        accountId: "work",
        peer: { kind: scenario.kind, id: scenario.peerId },
      });
      expect(
        inspectDiscordConversationRouteOwner({
          cfg,
          accountId: "work",
          conversation: { kind: scenario.kind, peerId: scenario.peerId },
        }),
      ).toEqual({ kind: "agent", agentId: route.agentId });
      const resolved = await resolveRuntimeConversationBindingRouteAsync({ route, conversation });
      expect({ ...resolved, route: Object.fromEntries(Object.entries(resolved.route)) }).toEqual({
        bindingOwnerAvailable: true,
        bindingRecord: null,
        route,
      });
      await expect(
        getSessionBindingService().resolveByConversationAsync(conversation),
      ).resolves.toBeNull();
    } finally {
      manager.stop();
    }
  },
);

it("keeps only the current disabled owner available and refuses work after retirement", async () => {
  const service = getSessionBindingService();
  const conversation = { channel: "discord", accountId: "work", conversationId: "user:123" };
  const predecessor = createNoopThreadBindingManager("work");
  const current = createNoopThreadBindingManager("work");
  predecessor.stop();
  predecessor.stop();
  expect(service.getCapabilities(conversation)).toEqual({
    adapterAvailable: true,
    bindSupported: false,
    unbindSupported: false,
    placements: [],
  });
  const available = await service.inspectByConversationAsync(conversation);
  expect(Object.fromEntries(Object.entries(available))).toEqual({
    status: "available",
    binding: null,
  });
  current.stop();
  current.stop();
  const unavailable = await service.inspectByConversationAsync(conversation);
  expect(Object.fromEntries(Object.entries(unavailable))).toEqual({
    status: "unavailable",
  });
  await expect(service.resolveByConversationAsync(conversation)).rejects.toMatchObject({
    code: "BINDING_ADAPTER_UNAVAILABLE",
  });
});
