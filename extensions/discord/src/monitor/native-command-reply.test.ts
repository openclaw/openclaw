import { MessageFlags } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDiscordComponentEntries,
  resolveDiscordComponentEntry,
} from "../components-registry.js";
import { Container, TextDisplay } from "../internal/discord.js";
import {
  deliverDiscordInteractionReply,
  hasRenderableReplyPayload,
} from "./native-command-reply.js";

function createInteraction() {
  return {
    reply: vi.fn().mockResolvedValue({ id: "reply-1" }),
    followUp: vi.fn().mockResolvedValue({ id: "follow-up-1" }),
    fetchReply: vi.fn().mockResolvedValue({ id: "fetched-1" }),
  };
}

describe("deliverDiscordInteractionReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDiscordComponentEntries();
  });

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

    await deliverDiscordInteractionReply({
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
  });

  it("sends component-only native command replies through the initial reply when not deferred", async () => {
    const interaction = createInteraction();
    const components = [new Container([new TextDisplay("Choose an action")])];

    await deliverDiscordInteractionReply({
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
  });

  it("builds and registers channelData Discord component specs for native command replies", async () => {
    const interaction = createInteraction();
    const payload = {
      text: "fallback text",
      channelData: {
        discord: {
          components: {
            blocks: [
              {
                type: "actions",
                buttons: [{ label: "Answer", callbackData: "ask:ask_test" }],
              },
            ],
          },
        },
      },
    };

    expect(hasRenderableReplyPayload({ channelData: payload.channelData })).toBe(true);

    await deliverDiscordInteractionReply({
      interaction: interaction as never,
      payload,
      textLimit: 2000,
      preferFollowUp: true,
      responseEphemeral: true,
      chunkMode: "length",
    });

    const sent = interaction.followUp.mock.calls[0]?.[0] as {
      content?: string;
      components?: Array<{ serialize: () => unknown }>;
      flags?: number;
      ephemeral?: boolean;
    };
    expect(sent.content).toBeUndefined();
    expect(sent.ephemeral).toBe(true);
    expect(sent.flags).toBe(MessageFlags.IsComponentsV2);
    expect(sent.components).toHaveLength(1);
    const serialized = sent.components?.[0]?.serialize() as {
      components?: Array<{ components?: Array<{ custom_id?: string }> }>;
    };
    const buttonCustomId = serialized.components?.[1]?.components?.[0]?.custom_id;
    expect(buttonCustomId).toMatch(/^occomp:cid=/);

    const componentId = buttonCustomId?.match(/cid=([^;]+)/)?.[1];
    expect(componentId).toBeTruthy();
    const entry = resolveDiscordComponentEntry({ id: componentId ?? "", consume: false });
    expect(entry?.callbackData).toBe("ask:ask_test");
    expect(entry?.messageId).toBe("follow-up-1");
  });
});
