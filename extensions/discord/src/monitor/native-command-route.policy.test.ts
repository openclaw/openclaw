import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { beforeEach, expect, it, vi } from "vitest";
import { resolveDiscordNativeInteractionRouteState } from "./native-command-route.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

const policy = vi.hoisted(() => ({ delegated: vi.fn() }));
const ordinaryRoute: ResolvedAgentRoute = {
  agentId: "main",
  channel: "discord",
  accountId: "default",
  sessionKey: "agent:main:discord:channel:room",
  mainSessionKey: "agent:main:main",
  lastRoutePolicy: "session",
  matchedBy: "default",
};
vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  isDelegatedChannelBindingTargetAsync: policy.delegated,
  resolveConfiguredBindingRoute: ({ route }: { route: ResolvedAgentRoute }) => ({
    route,
    bindingResolution: null,
  }),
}));
vi.mock("./route-resolution.js", () => ({
  resolveDiscordBoundConversationRoute: () => ordinaryRoute,
  resolveDiscordEffectiveRoute: ({
    route,
    boundSessionKey,
  }: {
    route: ResolvedAgentRoute;
    boundSessionKey?: string;
  }) => ({ ...route, sessionKey: boundSessionKey ?? route.sessionKey }),
}));

const binding: ThreadBindingRecord = {
  accountId: "default",
  channelId: "parent",
  threadId: "room",
  agentId: "worker",
  targetSessionKey: "agent:worker:dashboard:child",
  targetKind: "acp",
  boundBy: "human-1",
  boundAt: 1,
  lastActivityAt: 1,
};
const input = {
  cfg: {},
  accountId: "default",
  isDirectMessage: false,
  isGroupDm: false,
  conversationId: "room",
  threadBinding: binding,
};
beforeEach(() => policy.delegated.mockReset());

it.each([true, false])(
  "uses shared durable admission for raw command/model-picker bindings (delegated=%s)",
  async (delegated) => {
    policy.delegated.mockResolvedValue(delegated);
    const result = await resolveDiscordNativeInteractionRouteState(input);
    expect(policy.delegated).toHaveBeenCalledWith(
      {
        conversation: { channel: "discord" },
        targetSessionKey: binding.targetSessionKey,
        targetKind: "session",
        metadata: { boundBy: binding.boundBy, agentId: binding.agentId },
      },
      expect.any(Function),
      input.cfg,
    );
    expect(result.boundSessionKey).toBe(delegated ? undefined : binding.targetSessionKey);
    expect(result.effectiveRoute.sessionKey).toBe(
      delegated ? ordinaryRoute.sessionKey : binding.targetSessionKey,
    );
  },
);

it("refuses a raw manager binding replaced during durable inspection", async () => {
  let current = binding;
  policy.delegated.mockImplementation(async () => {
    current = { ...binding, targetSessionKey: "agent:replacement:main" };
    return false;
  });
  await expect(
    resolveDiscordNativeInteractionRouteState({ ...input, readThreadBinding: () => current }),
  ).rejects.toThrow("thread binding changed");
});
