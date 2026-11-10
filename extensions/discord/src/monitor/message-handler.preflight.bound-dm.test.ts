import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
import {
  testing as sessionBindingTesting,
  registerSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType } from "../internal/discord.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createThreadBinding,
  createDiscordMessage,
  createDiscordPreflightArgs,
  DEFAULT_PREFLIGHT_CFG,
  type DiscordClient,
  type DiscordConfig,
  type DiscordMessageEvent,
} from "./message-handler.preflight.test-helpers.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

let threadBindings: ReturnType<typeof createNoopThreadBindingManager>;

const { resolveDiscordDmCommandAccessMock, handleDiscordDmCommandDecisionMock } = vi.hoisted(
  () => ({
    resolveDiscordDmCommandAccessMock: vi.fn(),
    handleDiscordDmCommandDecisionMock: vi.fn(async () => {}),
  }),
);
vi.mock("./dm-command-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dm-command-auth.js")>()),
  resolveDiscordDmCommandAccess: resolveDiscordDmCommandAccessMock,
}));
vi.mock("./dm-command-decision.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dm-command-decision.js")>()),
  handleDiscordDmCommandDecision: handleDiscordDmCommandDecisionMock,
}));

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  threadBindings = createNoopThreadBindingManager("default");
  resolveDiscordDmCommandAccessMock.mockReset();
  handleDiscordDmCommandDecisionMock.mockClear();
});
afterEach(async () => {
  await threadBindings.stop();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});

const ALICE = { id: "user-1", bot: false, username: "alice" };

async function runDmPreflight({
  channelId,
  message,
  discordConfig,
}: {
  channelId: string;
  message: ReturnType<typeof createDiscordMessage>;
  discordConfig: DiscordConfig;
}) {
  return preflightDiscordMessage(
    createDiscordPreflightArgs({
      cfg: DEFAULT_PREFLIGHT_CFG,
      threadBindings,
      discordConfig,
      client: {
        fetchChannel: async (id: string) =>
          id === channelId ? { id: channelId, type: ChannelType.DM } : null,
      } as unknown as DiscordClient,
      data: { channel_id: channelId, author: message.author, message } as DiscordMessageEvent,
    }),
  );
}

function expectPreflightResult(result: Awaited<ReturnType<typeof preflightDiscordMessage>>) {
  if (result === null) {
    throw new Error("Expected Discord preflight result");
  }
  return result;
}

describe("bound direct messages", () => {
  let binding: ReturnType<typeof createThreadBinding>;

  beforeEach(() => {
    binding = createThreadBinding({
      targetKind: "session",
      targetSessionKey: "agent:main:main",
      conversation: { channel: "discord", accountId: "default", conversationId: "user:user-1" },
    });
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) => (ref.conversationId === "user:user-1" ? binding : null),
    });
  });

  it.each([
    { dmPolicy: "allowlist", decision: "block" },
    { dmPolicy: "pairing", decision: "pairing" },
  ] as const)("honors $dmPolicy access decisions", async ({ dmPolicy, decision }) => {
    resolveDiscordDmCommandAccessMock.mockResolvedValue({
      senderAccess: { allowed: false, decision, reasonCode: "dm_policy_not_allowlisted" },
      commandAccess: { authorized: false },
    });
    const result = await runDmPreflight({
      channelId: "dm-channel-policy",
      message: createDiscordMessage({
        id: "m-dm-policy",
        channelId: "dm-channel-policy",
        content: "hello",
        author: ALICE,
      }),
      discordConfig: { dmPolicy, allowFrom: ["other-user"] },
    });

    expect(result).toBeNull();
    expect(handleDiscordDmCommandDecisionMock).toHaveBeenCalledWith(
      expect.objectContaining({ senderAccess: expect.objectContaining({ decision }) }),
    );
  });

  it.each([false, true])(
    "preserves routing with command authorization %s for admitted senders",
    async (authorized) => {
      resolveDiscordDmCommandAccessMock.mockResolvedValue({
        senderAccess: { allowed: true, decision: "allow", reasonCode: "dm_policy_allowlisted" },
        commandAccess: { authorized },
      });
      const result = await runDmPreflight({
        channelId: "dm-channel-allowed",
        message: createDiscordMessage({
          id: "m-dm-allowed",
          channelId: "dm-channel-allowed",
          content: "hello",
          author: ALICE,
        }),
        discordConfig: { dmPolicy: "allowlist", allowFrom: [ALICE.id] },
      });

      const preflight = expectPreflightResult(result);
      expect(preflight.threadBinding).toEqual(binding);
      expect(preflight.route.sessionKey).toBe(binding.targetSessionKey);
      expect(preflight.commandAuthorized).toBe(authorized);
      expect(handleDiscordDmCommandDecisionMock).not.toHaveBeenCalled();
    },
  );
});
