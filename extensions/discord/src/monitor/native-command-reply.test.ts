// Discord tests cover native command reply plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Container, TextDisplay } from "../internal/discord.js";
import { createDiscordLoopbackRest } from "../send.test-harness.js";
import {
  deliverDiscordInteractionReply,
  hasRenderableReplyPayload,
  settleDiscordInteractionWithoutVisibleReply,
} from "./native-command-reply.js";

const loadWebMediaMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia: loadWebMediaMock,
}));

function createInteraction() {
  return {
    reply: vi.fn().mockResolvedValue({ ok: true }),
    followUp: vi.fn().mockResolvedValue({ ok: true }),
  };
}

describe("deliverDiscordInteractionReply", () => {
  beforeEach(() => {
    loadWebMediaMock.mockReset();
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

  it("preserves detected media content types on native command reply uploads", async () => {
    const interaction = createInteraction();
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("webp"),
      fileName: "sticker.webp",
      contentType: "image/webp",
      kind: "image",
    });

    await deliverDiscordInteractionReply({
      interaction: interaction as never,
      payload: {
        text: "sticker",
        mediaUrls: ["file:///tmp/sticker.webp"],
      },
      textLimit: 2000,
      preferFollowUp: false,
      chunkMode: "length",
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith("file:///tmp/sticker.webp", {
      localRoots: undefined,
    });
    const sentPayload = interaction.reply.mock.calls[0]?.[0] as
      | { files?: Array<{ data?: unknown; name?: string }> }
      | undefined;
    const uploadedBlob = sentPayload?.files?.[0]?.data;
    expect(sentPayload?.files).toHaveLength(1);
    expect(sentPayload?.files?.[0]?.name).toBe("sticker.webp");
    expect(uploadedBlob).toBeInstanceOf(Blob);
    expect((uploadedBlob as Blob).type).toBe("image/webp");
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("sends the detected WebP media type across a real interaction multipart request", async () => {
    const loopback = await createDiscordLoopbackRest();
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("webp"),
      fileName: "sticker.webp",
      contentType: "image/webp",
      kind: "image",
    });
    const interaction = {
      reply: vi.fn(async (data: unknown) =>
        loopback.rest.post("/interactions/123/token/callback", {
          body: { type: 4, data },
        }),
      ),
      followUp: vi.fn(),
    };

    try {
      await deliverDiscordInteractionReply({
        interaction: interaction as never,
        payload: {
          text: "sticker",
          mediaUrls: ["file:///tmp/sticker.webp"],
        },
        textLimit: 2000,
        preferFollowUp: false,
        chunkMode: "length",
      });

      const upload = loopback.requests.find((request) => request.method === "POST");
      expect(upload?.path).toContain("/interactions/123/token/callback");
      expect(upload?.contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(upload?.body).toContain('name="files[0]"; filename="sticker.webp"');
      expect(upload?.body).toContain("Content-Type: image/webp");
    } finally {
      await loopback.close();
    }
  });
});

describe("settleDiscordInteractionWithoutVisibleReply", () => {
  it("deletes a deferred slash-command loading response", async () => {
    const interaction = {
      responseState: "deferred",
      deleteReply: vi.fn().mockResolvedValue(undefined),
    };

    await settleDiscordInteractionWithoutVisibleReply(interaction as never);

    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
  });

  it.each(["unacknowledged", "deferred-update", "replied"])(
    "does not delete an interaction in the %s state",
    async (responseState) => {
      const interaction = {
        responseState,
        deleteReply: vi.fn().mockResolvedValue(undefined),
      };

      await settleDiscordInteractionWithoutVisibleReply(interaction as never);

      expect(interaction.deleteReply).not.toHaveBeenCalled();
    },
  );
});
