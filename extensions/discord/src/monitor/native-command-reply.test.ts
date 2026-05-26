import { describe, expect, it, vi } from "vitest";
import { Container, TextDisplay } from "../internal/discord.js";
import {
  deliverDiscordInteractionReply,
  hasRenderableReplyPayload,
} from "./native-command-reply.js";

function createInteraction() {
  return {
    reply: vi.fn().mockResolvedValue({ ok: true }),
    followUp: vi.fn().mockResolvedValue({ ok: true }),
  };
}

describe("deliverDiscordInteractionReply", () => {
  it("sends component-only native command replies as follow-ups", async () => {
    const interaction = createInteraction();
    const components = [new Container([new TextDisplay("Pick a model")])];
    const payload = {
      channelData: {
        discord: {
          components,
        },
      },
    };

    expect(hasRenderableReplyPayload(payload)).toBe(true);

    const delivered = await deliverDiscordInteractionReply({
      interaction: interaction as never,
      payload,
      textLimit: 2000,
      preferFollowUp: true,
      responseEphemeral: true,
      chunkMode: "length",
    });

    expect(interaction.followUp).toHaveBeenCalledWith({
      components,
      ephemeral: true,
    });
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(delivered).toBe(true);
  });

  it("sends component-only native command replies through the initial reply when not deferred", async () => {
    const interaction = createInteraction();
    const components = [new Container([new TextDisplay("Choose an action")])];

    const delivered = await deliverDiscordInteractionReply({
      interaction: interaction as never,
      payload: {
        channelData: {
          discord: {
            components,
          },
        },
      },
      textLimit: 2000,
      preferFollowUp: false,
      chunkMode: "length",
    });

    expect(interaction.reply).toHaveBeenCalledWith({
      components,
    });
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(delivered).toBe(true);
  });

  it("reports no delivery when Discord rejects an expired interaction", async () => {
    const interaction = createInteraction();
    interaction.reply.mockRejectedValueOnce({
      rawBody: { code: 10062, message: "Unknown interaction" },
    });

    const delivered = await deliverDiscordInteractionReply({
      interaction: interaction as never,
      payload: { text: "too late" },
      textLimit: 2000,
      preferFollowUp: false,
      chunkMode: "length",
    });

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(delivered).toBe(false);
  });
});
