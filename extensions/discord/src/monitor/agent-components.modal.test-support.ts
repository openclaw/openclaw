import { InteractionResponseType, MessageFlags } from "discord-api-types/v10";
import { expect, vi } from "vitest";
import { buildDiscordComponentCustomId } from "../component-custom-id.js";
import type { DiscordModalEntry } from "../components.js";
import { BaseComponentInteraction, createInteraction } from "../internal/discord.js";
import {
  attachRestMock,
  createInternalComponentInteractionPayload,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";

export const modalFixture = {
  id: "mdl_1",
  title: "Details",
  fields: [{ id: "fld_1", name: "name", label: "Name", type: "text" }],
} satisfies DiscordModalEntry;

export function createButtonInteraction(id: string, post = vi.fn().mockResolvedValue(undefined)) {
  const client = createInternalTestClient();
  const patch = vi.fn();
  attachRestMock(client, { post, patch });
  const interaction = createInteraction(
    client,
    createInternalComponentInteractionPayload({
      id,
      token: "interaction-token",
      channel_id: "dm-channel",
      user: {
        id: "123456789",
        username: "AgentUser",
        discriminator: "0001",
        global_name: null,
        avatar: null,
      },
      data: {
        custom_id: buildDiscordComponentCustomId({ componentId: "btn_1", modalId: "mdl_1" }),
      },
    }),
  );
  if (!(interaction instanceof BaseComponentInteraction)) {
    throw new Error("expected Discord button interaction");
  }
  return { interaction, patch, post };
}

export function ephemeralReply(content: string) {
  return {
    body: {
      type: InteractionResponseType.ChannelMessageWithSource,
      data: { content, flags: MessageFlags.Ephemeral },
    },
  };
}

export const modalReply = () =>
  expect.objectContaining({
    body: expect.objectContaining({ type: InteractionResponseType.Modal }),
  });
