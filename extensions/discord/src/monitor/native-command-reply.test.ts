// Discord tests cover native command reply plugin behavior.
import { setImmediate } from "node:timers/promises";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discordComponentRegistryState } from "../components-registry-state.js";
import { resolveDiscordComponentEntryWithPersistence } from "../components-registry.js";
import { clearDiscordComponentEntriesForTest } from "../components-registry.test-support.js";
import { parseDiscordComponentCustomId } from "../components.js";
import { Button, Container, Row, TextDisplay, type MessagePayload } from "../internal/discord.js";
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
    reply: vi.fn<(payload: MessagePayload) => Promise<unknown>>().mockResolvedValue({ ok: true }),
    followUp: vi
      .fn<(payload: MessagePayload) => Promise<unknown>>()
      .mockResolvedValue({ ok: true }),
  };
}

describe("deliverDiscordInteractionReply", () => {
  beforeEach(() => {
    loadWebMediaMock.mockReset();
    clearDiscordComponentEntriesForTest();
  });

  afterEach(() => clearDiscordComponentEntriesForTest());

  it.each([
    { preferFollowUp: false, expires: false },
    { preferFollowUp: true, expires: false },
    { preferFollowUp: false, expires: true },
  ])(
    "registers shared command buttons only after accepted native delivery: %j",
    async ({ preferFollowUp, expires }) => {
      const interaction = createInteraction();
      const started = createDeferred<void>();
      const accepted = createDeferred<unknown>();
      const sender = preferFollowUp ? interaction.followUp : interaction.reply;
      sender.mockImplementation(() => {
        started.resolve();
        return accepted.promise;
      });
      const payload: ReplyPayload = {
        text: "Choose model access: /login choice token 0 or /login choice token 1",
        presentationTextMode: "fallback",
        presentation: {
          blocks: [
            { type: "text", text: "Credentials saved. Choose model access." },
            {
              type: "buttons",
              buttons: [
                {
                  label: "Show all Example models",
                  action: { type: "command", command: "/login choice token 0" },
                },
                {
                  label: "Keep current restrictions",
                  action: { type: "command", command: "/login choice token 1" },
                },
              ],
            },
          ],
        },
      };
      const delivery = deliverDiscordInteractionReply({
        interaction: interaction as never,
        payload,
        componentRoute: {
          accountId: "work",
          agentId: "assistant",
          sessionKey: "agent:assistant:discord:direct:owner",
        },
        textLimit: 2000,
        preferFollowUp,
        responseEphemeral: true,
        chunkMode: "length",
      });
      const outcome = delivery.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await started.promise;
      const message = sender.mock.calls[0]?.[0];
      if (!message || typeof message === "string") {
        throw new Error("Expected a native component message");
      }
      expect(message).not.toHaveProperty("content");
      expect(message.ephemeral).toBe(true);
      const container = message.components?.[0];
      if (!(container instanceof Container)) {
        throw new Error("Expected a shared presentation container");
      }
      const buttons = container.components
        .flatMap((part) => (part instanceof Row ? part.components : []))
        .filter((part): part is Button => part instanceof Button);
      expect(buttons.map((button) => button.label)).toEqual([
        "Show all Example models",
        "Keep current restrictions",
      ]);
      const ids = buttons.map((button) => {
        const parsed = parseDiscordComponentCustomId(button.customId);
        if (!parsed) {
          throw new Error("Expected a registered component ID");
        }
        return parsed.componentId;
      });
      for (const id of ids) {
        expect(
          await resolveDiscordComponentEntryWithPersistence({ id, consume: false }),
        ).toBeNull();
      }
      if (expires) {
        accepted.reject({ discordCode: 10062 });
      } else {
        accepted.resolve(preferFollowUp ? { id: "native-message" } : undefined);
      }
      const result = await outcome;
      if (expires) {
        expect(result).toEqual({ error: expect.any(PlatformMessageNotDispatchedError) });
        for (const id of ids) {
          expect(
            await resolveDiscordComponentEntryWithPersistence({ id, consume: false }),
          ).toBeNull();
        }
        return;
      }
      expect(result).toEqual({ value: true });
      const entries = await Promise.all(
        ids.map((id) => resolveDiscordComponentEntryWithPersistence({ id, consume: false })),
      );
      expect(entries).toMatchObject([
        {
          callbackData: "/login choice token 0",
          callbackDataKind: "command",
          label: "Show all Example models",
        },
        {
          callbackData: "/login choice token 1",
          callbackDataKind: "command",
          label: "Keep current restrictions",
        },
      ]);
      for (const entry of entries) {
        expect(entry).toMatchObject({
          accountId: "work",
          agentId: "assistant",
          sessionKey: "agent:assistant:discord:direct:owner",
        });
        expect(entry?.messageId).toBe(preferFollowUp ? "native-message" : undefined);
      }
    },
  );

  it.each([false, true])(
    "waits for native button persistence without changing delivery on failure=%s",
    async (fail) => {
      const started = createDeferred<void>();
      const registered = createDeferred<void>();
      discordComponentRegistryState.persistentComponentStore = {
        register: async () => {
          started.resolve();
          await registered.promise;
        },
        lookup: async () => undefined,
        consume: async () => undefined,
        delete: async () => false,
      };
      const interaction = createInteraction();
      let completed = false;
      const delivery = deliverDiscordInteractionReply({
        interaction: interaction as never,
        payload: {
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Choose", action: { type: "command", command: "/help" } }],
              },
            ],
          },
        },
        componentRoute: {
          accountId: "default",
          agentId: "assistant",
          sessionKey: "agent:assistant:discord:direct:fixture",
        },
        textLimit: 2000,
        preferFollowUp: false,
        chunkMode: "length",
      }).then((value) => {
        completed = true;
        return value;
      });
      try {
        await started.promise;
        await setImmediate();
        expect(interaction.reply).toHaveBeenCalledOnce();
        expect(completed).toBe(false);
        if (fail) {
          registered.reject(new Error("synthetic persistence unavailable"));
        } else {
          registered.resolve();
        }
        expect(await delivery).toBe(true);
        expect(discordComponentRegistryState.persistentRegistryDisabled).toBe(fail);
      } finally {
        registered.resolve();
        await delivery;
      }
    },
  );

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

  it.each([true, false])(
    "sends embed-only native command replies with preferFollowUp=%s",
    async (preferFollowUp) => {
      const interaction = createInteraction();
      const embeds = [{ title: "Status", description: "All systems operational" }];
      const payload = { channelData: { discord: { embeds } } };

      expect(hasRenderableReplyPayload(payload)).toBe(true);
      await expect(
        deliverDiscordInteractionReply({
          interaction: interaction as never,
          payload,
          textLimit: 2000,
          preferFollowUp,
          responseEphemeral: true,
          chunkMode: "length",
        }),
      ).resolves.toBe(true);

      const sender = preferFollowUp ? interaction.followUp : interaction.reply;
      expect(sender).toHaveBeenCalledWith({ embeds, ephemeral: true });
    },
  );

  it.each([
    { includeMedia: false, includeEmbeds: true },
    { includeMedia: true, includeEmbeds: true },
    { includeMedia: true, includeEmbeds: false },
  ])(
    "preserves native attachments and embeds with shared presentation: %j",
    async ({ includeMedia, includeEmbeds }) => {
      const interaction = createInteraction();
      const embeds = [{ title: "Status" }];
      if (includeMedia) {
        loadWebMediaMock.mockResolvedValue({
          buffer: Buffer.from("image"),
          fileName: "status.png",
          contentType: "image/png",
        });
      }

      await deliverDiscordInteractionReply({
        interaction: interaction as never,
        payload: {
          text: "x".repeat(2_100),
          presentationTextMode: "fallback",
          presentation: {
            blocks: [
              { type: "text", text: "Status details" },
              {
                type: "buttons",
                buttons: [{ label: "Continue", action: { type: "command", command: "/status" } }],
              },
            ],
          },
          ...(includeMedia ? { mediaUrls: ["file:///tmp/status.png"] } : {}),
          ...(includeEmbeds ? { channelData: { discord: { embeds } } } : {}),
        },
        textLimit: 2000,
        preferFollowUp: false,
        chunkMode: "length",
      });

      expect(interaction.reply).toHaveBeenCalledWith({
        content: "x".repeat(2_000),
        ...(includeEmbeds ? { embeds } : {}),
        ...(includeMedia
          ? {
              files: [{ name: "status.png", data: Buffer.from("image"), contentType: "image/png" }],
            }
          : {}),
      });
      expect(interaction.followUp).toHaveBeenCalledWith({ content: "x".repeat(100) });
    },
  );

  it("omits legacy content and embeds from native Components V2 replies", async () => {
    const interaction = createInteraction();
    const components = [{ type: 17, components: [{ type: 10, content: "Choose" }] }];

    await deliverDiscordInteractionReply({
      interaction: interaction as never,
      payload: {
        text: "legacy fallback",
        channelData: {
          discord: { components, embeds: [{ title: "legacy embed" }] },
        },
      },
      textLimit: 2000,
      preferFollowUp: false,
      chunkMode: "length",
    });

    expect(interaction.reply).toHaveBeenCalledWith({ components });
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "plural media URLs",
      media: { mediaUrls: ["file:///tmp/sticker.webp"] },
    },
    {
      name: "singular media URL after blank plural URLs",
      media: { mediaUrls: ["   "], mediaUrl: "file:///tmp/sticker.webp" },
    },
  ])(
    "sends detected WebP media across a real interaction multipart request ($name)",
    async ({ media }) => {
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
        const payload = { text: "sticker", ...media };
        expect(hasRenderableReplyPayload(payload)).toBe(true);

        await deliverDiscordInteractionReply({
          interaction: interaction as never,
          payload,
          textLimit: 2000,
          preferFollowUp: false,
          chunkMode: "length",
        });

        expect(loadWebMediaMock).toHaveBeenCalledWith("file:///tmp/sticker.webp", {
          localRoots: undefined,
        });
        const upload = loopback.requests.find((request) => request.method === "POST");
        expect(upload?.path).toContain("/interactions/123/token/callback");
        expect(upload?.contentType).toMatch(/^multipart\/form-data; boundary=/);
        expect(upload?.body).toContain('name="files[0]"; filename="sticker.webp"');
        expect(upload?.body).toContain("Content-Type: image/webp");
      } finally {
        await loopback.close();
      }
    },
  );
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
