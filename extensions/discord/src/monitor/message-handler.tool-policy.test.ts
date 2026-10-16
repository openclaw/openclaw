import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDiscordPolicyBindings } from "../channel-policy-state.js";
import { resolveDiscordGroupToolPolicy } from "../group-policy.js";
import { ChannelType } from "../internal/discord.js";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import type { DiscordGuildEntryResolved } from "./allow-list.js";
import { buildDiscordMessageProcessContext } from "./message-handler.context.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
  createThreadClient,
} from "./message-handler.preflight.test-helpers.js";

installDiscordIngressTestRuntime();

describe("Discord admitted conversation tool policy", () => {
  afterEach(() => setDiscordPolicyBindings("default", []));

  it.each([
    { name: "text-channel thread", parentType: ChannelType.GuildText },
    { name: "forum post", parentType: ChannelType.GuildForum },
    { name: "renamed channel", parentType: undefined },
  ])("preserves tool policy for a $name", async ({ parentType }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const isThread = parentType !== undefined;
      const channelId = isThread ? "357" : "999";
      const guilds = {
        "145": {
          requireMention: false,
          tools: isThread ? { allow: ["exec"] } : { deny: ["exec"] },
          channels: {
            "246": {
              tools: { deny: ["exec"] },
              toolsBySender: { "id:111": { allow: ["read"] } },
              includeThreadStarter: false,
            },
            general: {
              tools: { allow: ["exec"] },
              toolsBySender: { "id:111": { allow: ["write"] } },
            },
          },
        },
      };
      // Admission sees resolved entries; tool policy is read from the authored config.
      const guildEntries: Record<string, DiscordGuildEntryResolved> = {
        "145": {
          requireMention: false,
          channels: { "246": { includeThreadStarter: false }, general: {} },
        },
      };
      const cfg: OpenClawConfig = {
        session: { store: state.path("sessions.json") },
        channels: { discord: { guilds } },
      };
      setDiscordPolicyBindings("default", [
        { guildKey: "145", channelKey: "general", channelId: "444" },
      ]);
      const client = isThread
        ? createThreadClient({ threadId: channelId, parentId: "246" })
        : createGuildTextClient(channelId);
      const fetchChannel = client.fetchChannel.bind(client);
      vi.spyOn(client, "fetchChannel").mockImplementation(async (id) => {
        const channel = await fetchChannel(id);
        if (id === "246" && channel && parentType !== undefined) {
          Object.assign(channel, { type: parentType });
        }
        return channel;
      });

      for (const [senderId, expected] of [
        ["222", { deny: ["exec"] }],
        ["111", isThread ? { allow: ["read"] } : { deny: ["exec"] }],
      ] as const) {
        const message = createDiscordMessage({
          id: `100${senderId}`,
          channelId,
          content: "Please inspect this thread.",
          author: { id: senderId, username: "member", bot: false },
        });
        const preflight = await preflightDiscordMessage({
          ...createDiscordPreflightArgs({
            cfg,
            discordConfig: cfg.channels?.discord,
            client,
            data: createGuildEvent({
              channelId,
              guildId: "145",
              author: message.author,
              message,
            }),
          }),
          guildEntries,
          groupPolicy: "allowlist",
        });
        expect(preflight).not.toBeNull();
        if (!preflight) {
          throw new Error("Expected an admitted Discord thread message");
        }
        const result = await buildDiscordMessageProcessContext({
          ctx: preflight,
          text: preflight.messageText,
          mediaList: [],
        });
        expect(result).not.toBeNull();
        const payload = result!.ctxPayload;
        const policy =
          payload.ConversationToolPolicy ??
          resolveDiscordGroupToolPolicy({
            cfg,
            accountId: payload.AccountId,
            groupId: payload.NativeChannelId,
            groupSpace: payload.GroupSpace,
            groupChannel: payload.GroupChannel,
            senderId: payload.SenderId,
          });
        expect(policy).toEqual(expected);
      }
    });
  });
});
