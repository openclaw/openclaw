import type { ButtonInteraction, ComponentData, StringSelectMenuInteraction } from "@buape/carbon";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-runtime";
import * as conversationRuntime from "openclaw/plugin-sdk/conversation-runtime";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import * as securityRuntime from "openclaw/plugin-sdk/security-runtime";
import { peekSystemEvents, resetSystemEventsForTest } from "openclaw/plugin-sdk/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectPairingReplyText } from "../../../../test/helpers/pairing-reply.js";
import {
  readAllowFromStoreMock,
  resetDiscordComponentRuntimeMocks,
  upsertPairingRequestMock,
} from "../../../../test/helpers/plugins/discord-component-runtime.js";
import { createAgentComponentButton, createAgentSelectMenu } from "./agent-components.js";

describe("agent components", () => {
  const defaultDmSessionKey = buildAgentSessionKey({
    agentId: "main",
    channel: "discord",
    accountId: "default",
    peer: { kind: "direct", id: "123456789" },
  });

  const createCfg = (): OpenClawConfig => ({}) as OpenClawConfig;

  const createBaseDmInteraction = (overrides: Record<string, unknown> = {}) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const defer = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      rawData: { channel_id: "dm-channel" },
      user: { id: "123456789", username: "Alice", discriminator: "1234" },
      defer,
      reply,
      ...overrides,
    };
    return { interaction, defer, reply };
  };

  const createDmButtonInteraction = (overrides: Partial<ButtonInteraction> = {}) => {
    const { interaction, defer, reply } = createBaseDmInteraction(
      overrides as Record<string, unknown>,
    );
    return {
      interaction: interaction as unknown as ButtonInteraction,
      defer,
      reply,
    };
  };

  const createDmSelectInteraction = (overrides: Partial<StringSelectMenuInteraction> = {}) => {
    const { interaction, defer, reply } = createBaseDmInteraction({
      values: ["alpha"],
      ...(overrides as Record<string, unknown>),
    });
    return {
      interaction: interaction as unknown as StringSelectMenuInteraction,
      defer,
      reply,
    };
  };

  beforeEach(() => {
    resetDiscordComponentRuntimeMocks();
    resetSystemEventsForTest();
    vi.spyOn(securityRuntime, "readStoreAllowFromForDmPolicy").mockImplementation(
      async (params) => {
        if (params.shouldRead === false || params.dmPolicy === "allowlist") {
          return [];
        }
        return await readAllowFromStoreMock(params.provider, params.accountId);
      },
    );
    vi.spyOn(conversationRuntime, "upsertChannelPairingRequest").mockImplementation(
      upsertPairingRequestMock,
    );
  });

  it("sends pairing reply when DM sender is not allowlisted", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "pairing",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    const pairingText = String(reply.mock.calls[0]?.[0]?.content ?? "");
    const code = expectPairingReplyText(pairingText, {
      channel: "discord",
      idLine: "Your Discord user id: 123456789",
    });
    expect(pairingText).toContain(`openclaw pairing approve discord ${code}`);
    expect(peekSystemEvents(defaultDmSessionKey)).toEqual([]);
    expect(readAllowFromStoreMock).toHaveBeenCalledWith("discord", "default");
  });

  it("blocks DM interactions in allowlist mode when sender is not in configured allowFrom", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(peekSystemEvents(defaultDmSessionKey)).toEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("authorizes DM interactions from pairing-store entries in pairing mode", async () => {
    readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "pairing",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(peekSystemEvents(defaultDmSessionKey)).toEqual([
      "[Discord component: hello clicked by Alice#1234 (123456789)]",
    ]);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(readAllowFromStoreMock).toHaveBeenCalledWith("discord", "default");
  });

  it("allows DM component interactions in open mode without reading pairing store", async () => {
    readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "open",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(peekSystemEvents(defaultDmSessionKey)).toEqual([
      "[Discord component: hello clicked by Alice#1234 (123456789)]",
    ]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("blocks DM component interactions in disabled mode without reading pairing store", async () => {
    readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "disabled",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "DM interactions are disabled.",
      ephemeral: true,
    });
    expect(peekSystemEvents(defaultDmSessionKey)).toEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("matches tag-based allowlist entries for DM select menus", async () => {
    const select = createAgentSelectMenu({
      cfg: createCfg(),
      accountId: "default",
      discordConfig: { dangerouslyAllowNameMatching: true } as DiscordAccountConfig,
      dmPolicy: "allowlist",
      allowFrom: ["Alice#1234"],
    });
    const { interaction, defer, reply } = createDmSelectInteraction();

    await select.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(peekSystemEvents(defaultDmSessionKey)).toEqual([
      "[Discord select menu: hello interacted by Alice#1234 (123456789) (selected: alpha)]",
    ]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("accepts cid payloads for agent button interactions", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["123456789"],
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { cid: "hello_cid" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(peekSystemEvents(defaultDmSessionKey)).toEqual([
      "[Discord component: hello_cid clicked by Alice#1234 (123456789)]",
    ]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("keeps malformed percent cid values without throwing", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["123456789"],
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { cid: "hello%2G" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(peekSystemEvents(defaultDmSessionKey)).toEqual([
      "[Discord component: hello%2G clicked by Alice#1234 (123456789)]",
    ]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });
});
