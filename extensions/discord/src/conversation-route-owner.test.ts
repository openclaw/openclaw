import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ConversationBindingInspection as Inspection } from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
import { expect, it } from "vitest";
import { prepareDiscordConversationRouteOwnersAsync as prepare } from "./conversation-route-owner.js";

type Input = Parameters<typeof prepare>[0][number];
const input: Input = {
  cfg: {},
  accountId: "default",
  conversation: { kind: "channel", peerId: "channel-1" },
};
const binding = {
  bindingId: "binding-1",
  targetSessionKey: "agent:finance:bound",
  targetKind: "session",
  conversation: { channel: "discord", accountId: "default", conversationId: "channel-1" },
  status: "active",
  boundAt: 1,
} as const;

async function inspect(
  overrides: Partial<Input> = {},
  inspection: Inspection = { status: "available", binding: null },
) {
  const [resolve] = await prepare([{ ...input, ...overrides }], async () => () => [inspection]);
  return resolve!();
}

it.each([
  ["direct", "user:user-1"],
  ["group", "native-1"],
  ["channel", "native-1"],
] as const)("prepares the %s runtime identity", async (kind, conversationId) => {
  const conversation = { kind, peerId: "user-1", nativeChannelId: "native-1" };
  const [resolve] = await prepare(
    [{ ...input, conversation }],
    async (refs) => () =>
      refs.map((ref) => ({
        status: "available" as const,
        binding: ref.conversationId === conversationId ? { ...binding, conversation: ref } : null,
      })),
  );
  expect(resolve!()).toEqual({ kind: "agent", agentId: "finance" });
});

it("reports unavailable bindings only while enabled", async () => {
  const unavailable: Inspection = { status: "unavailable" };
  expect(await inspect({}, unavailable)).toEqual({ kind: "unavailable" });
  expect(
    await inspect(
      { cfg: { channels: { discord: { threadBindings: { enabled: false } } } } },
      unavailable,
    ),
  ).toEqual({ kind: "agent", agentId: "main" });
});

it.each<[string, string, NonNullable<OpenClawConfig["channels"]>["discord"]]>([
  ["removed account", "retired", { accounts: { default: {} } }],
  ["disabled account", "default", { accounts: { default: { enabled: false } } }],
  ["disabled channel", "default", { enabled: false, accounts: { default: { enabled: true } } }],
])("rejects a %s without a runtime owner", async (_name, accountId, discord) => {
  expect(
    await inspect({ cfg: { channels: { discord } }, accountId }, { status: "unavailable" }),
  ).toBeNull();
});

it("preserves explicit plugin ownership independently of the target session", async () => {
  const owned = {
    ...binding,
    targetSessionKey: "agent:review:looks-owned",
    metadata: {
      pluginBindingOwner: "plugin",
      pluginId: "review-plugin",
      pluginRoot: "/plugins/review",
    },
  };
  expect(await inspect({}, { status: "available", binding: owned })).toEqual({
    kind: "plugin",
    pluginId: "review-plugin",
    fallbackAgentId: "main",
  });
});
