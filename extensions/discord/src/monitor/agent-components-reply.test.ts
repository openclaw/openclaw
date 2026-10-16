import {
  ChannelType,
  ComponentType,
  InteractionType,
  Locale,
  MessageFlags,
  MessageType,
} from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { ButtonInteraction } from "../internal/interactions.js";
import { replySilently } from "./agent-components-reply.js";

function fixture(flags = MessageFlags.IsComponentsV2) {
  const post = vi.fn(async () => undefined);
  const patch = vi.fn(async () => undefined);
  // Only external REST I/O is mocked; native state and payload serialization run.
  const client = {
    options: { clientId: "app1" },
    rest: { post, patch },
  } as unknown as ConstructorParameters<typeof ButtonInteraction>[0];
  const raw = {
    id: "interaction1",
    token: "token1",
    type: InteractionType.MessageComponent,
    version: 1,
    application_id: "app1",
    app_permissions: "0",
    locale: Locale.EnglishUS,
    entitlements: [],
    authorizing_integration_owners: {},
    attachment_size_limit: 10 * 1024 * 1024,
    channel_id: "channel1",
    channel: { id: "channel1", type: ChannelType.DM },
    data: { component_type: ComponentType.Button, custom_id: "button1" },
    message: {
      id: "source1",
      channel_id: "channel1",
      author: {
        id: "app1",
        username: "test-bot",
        discriminator: "0000",
        global_name: null,
        avatar: null,
        bot: true,
      },
      flags,
      content: "",
      timestamp: "2026-10-11T00:00:00.000Z",
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      attachments: [],
      embeds: [],
      pinned: false,
      type: MessageType.Default,
      components: [],
    },
  } satisfies ConstructorParameters<typeof ButtonInteraction>[1];
  return { interaction: new ButtonInteraction(client, raw), post, patch };
}

describe("replySilently", () => {
  it.each([MessageFlags.IsComponentsV2, 0])(
    "sends private feedback without editing a deferred-update source with flags %s",
    async (flags) => {
      const f = fixture(flags);
      await f.interaction.acknowledge();
      await replySilently(f.interaction, { content: "ack", ephemeral: false });

      expect(f.post).toHaveBeenNthCalledWith(1, "/interactions/interaction1/token1/callback", {
        body: { type: 6 },
      });
      expect(f.post).toHaveBeenNthCalledWith(
        2,
        "/webhooks/app1/token1",
        { body: { content: "ack", flags: MessageFlags.Ephemeral } },
        undefined,
      );
      expect(f.patch).not.toHaveBeenCalled();
      expect(f.interaction.responseState).toBe("deferred-update");
      expect(f.interaction.hasSentFollowUp).toBe(true);
    },
  );

  it("preserves the initial private callback before acknowledgement", async () => {
    const f = fixture();
    await replySilently(f.interaction, { content: "ack", ephemeral: true });
    expect(f.post).toHaveBeenCalledExactlyOnceWith("/interactions/interaction1/token1/callback", {
      body: { type: 4, data: { content: "ack", flags: MessageFlags.Ephemeral } },
    });
    expect(f.patch).not.toHaveBeenCalled();
  });

  it("preserves editing a privately deferred reply", async () => {
    const f = fixture();
    await f.interaction.defer({ ephemeral: true });
    await replySilently(f.interaction, { content: "ack", ephemeral: true });
    expect(f.patch).toHaveBeenCalledExactlyOnceWith("/webhooks/app1/token1/messages/%40original", {
      body: { content: "ack", flags: MessageFlags.Ephemeral },
    });
    expect(f.post).toHaveBeenCalledTimes(1);
  });

  it("preserves follow-up routing after an initial reply", async () => {
    const f = fixture();
    await f.interaction.reply({ content: "initial", ephemeral: true });
    await replySilently(f.interaction, { content: "ack", ephemeral: true });
    expect(f.post).toHaveBeenNthCalledWith(
      2,
      "/webhooks/app1/token1",
      { body: { content: "ack", flags: MessageFlags.Ephemeral } },
      undefined,
    );
    expect(f.patch).not.toHaveBeenCalled();
  });

  it("reports failed feedback without throwing or retrying the original message", async () => {
    const f = fixture();
    await f.interaction.acknowledge();
    const error = new Error("offline feedback failure");
    f.post.mockRejectedValueOnce(error);
    const onError = vi.fn();
    await expect(
      replySilently(f.interaction, { content: "ack" }, onError),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.patch).not.toHaveBeenCalled();
  });
});
