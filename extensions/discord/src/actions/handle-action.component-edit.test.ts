import { ComponentType, MessageFlags } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as discordClient from "../client.js";
import { resolveDiscordComponentEntryWithPersistence } from "../components-registry.js";
import { clearDiscordComponentEntriesForTest } from "../components-registry.test-support.js";
import {
  buildDiscordComponentMessage,
  parseDiscordComponentCustomId,
  type DiscordComponentMessageSpec,
} from "../components.js";
import { serializePayload } from "../internal/payload.js";
import { registerBuiltDiscordComponentMessage } from "../send.components.js";
import { createDiscordLoopbackRest } from "../send.test-harness.js";
import { handleDiscordMessageAction } from "./handle-action.js";

const cfg: OpenClawConfig = {
  channels: { discord: { token: "synthetic-token", groupPolicy: "open" } },
};
const sourceSession = "agent:source:discord:channel:789";
const card: DiscordComponentMessageSpec = {
  reusable: true,
  blocks: [
    { type: "text", text: "Task @everyone" },
    { type: "text", text: "No check-ins yet." },
    {
      type: "actions",
      buttons: [
        { label: "Complete", style: "success", allowedUsers: ["*"], callbackData: "demo:complete" },
      ],
    },
  ],
};
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  clearDiscordComponentEntriesForTest();
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

async function fixture() {
  const built = buildDiscordComponentMessage({
    spec: card,
    sessionKey: sourceSession,
    agentId: "source",
    accountId: "default",
  });
  await registerBuiltDiscordComponentMessage({ buildResult: built, messageId: "1001" });
  let stored = {
    id: "1001",
    channel_id: "789",
    ...serializePayload({ components: built.components }),
  };
  const loopback = await createDiscordLoopbackRest({
    respond: ({ method, path, body }) => {
      if (path === "/v10/channels/789") {
        return { id: "789", type: 0, guild_id: "333" };
      }
      if (method === "PATCH") {
        stored = { ...stored, ...JSON.parse(body) };
      }
      return stored;
    },
  });
  cleanup.push(loopback.close);
  const createClient = discordClient.createDiscordClient;
  vi.spyOn(discordClient, "createDiscordClient").mockImplementation((opts) =>
    createClient({ ...opts, rest: loopback.rest }),
  );
  vi.spyOn(discordClient, "resolveDiscordRest").mockReturnValue(loopback.rest);
  return { ...loopback, built, stored: () => stored };
}

function edit(components: unknown, config = cfg) {
  return handleDiscordMessageAction({
    action: "edit",
    params: { messageId: "1001", components },
    cfg: config,
    toolContext: { currentChannelProvider: "discord", currentChannelId: "channel:789" },
  });
}

describe("Discord card edits through the message action", () => {
  it("updates and retires a reusable card without losing callback routing or re-pinging", async () => {
    const test = await fixture();
    await edit({
      ...card,
      blocks: [
        { type: "text", text: "Task @everyone" },
        { type: "text", text: "Completed: Casey" },
        card.blocks?.[2],
      ],
    });
    const patch = test.requests.find((request) => request.method === "PATCH");
    expect(patch?.path).toBe("/v10/channels/789/messages/1001");
    const body = JSON.parse(patch!.body);
    expect(body).toMatchObject({ content: null, embeds: [], sticker_ids: [], poll: null });
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.flags & MessageFlags.IsComponentsV2).toBe(MessageFlags.IsComponentsV2);
    const children = body.components[0].components;
    expect(children.slice(0, 2)).toEqual([
      { type: ComponentType.TextDisplay, content: "Task @everyone" },
      { type: ComponentType.TextDisplay, content: "Completed: Casey" },
    ]);
    const button = children[2].components[0];
    expect(button.label).toBe("Complete");
    const parsed = parseDiscordComponentCustomId(button.custom_id);
    expect(parsed).not.toBeNull();
    const entry = await resolveDiscordComponentEntryWithPersistence({
      id: parsed!.componentId,
      consume: false,
    });
    expect(entry).toMatchObject({
      messageId: "1001",
      accountId: "default",
      sessionKey: sourceSession,
      agentId: "source",
      callbackData: "demo:complete",
      reusable: true,
      allowedUsers: ["*"],
    });

    await edit({ blocks: [{ type: "text", text: "Task @everyone\nCompleted: Casey" }] });
    expect(test.stored().components).toEqual([
      {
        type: ComponentType.Container,
        components: [
          { type: ComponentType.TextDisplay, content: "Task @everyone\nCompleted: Casey" },
        ],
      },
    ]);
    expect(test.requests.filter((request) => request.method === "POST")).toEqual([]);
  });

  it("keeps message-action gates and component validation ahead of edits", async () => {
    const test = await fixture();
    await expect(
      edit(card, {
        channels: { discord: { ...cfg.channels?.discord, actions: { messages: false } } },
      }),
    ).rejects.toThrow("Discord message edits are disabled");
    await expect(edit({})).rejects.toThrow("structured component specification");
    expect(test.requests.filter((request) => request.method === "PATCH")).toEqual([]);
  });
});
