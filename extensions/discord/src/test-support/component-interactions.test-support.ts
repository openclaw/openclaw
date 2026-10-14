import { ChannelType } from "discord-api-types/v10";
import { vi } from "vitest";
import type { DiscordComponentEntry, DiscordModalEntry } from "../components.js";
import type {
  ButtonInteraction,
  ModalInteraction,
  StringSelectMenuInteraction,
} from "../internal/discord.js";

const createComponentInteractionBase = (senderId = "123456789") => {
  const reply = vi.fn().mockResolvedValue(undefined);
  const defer = vi.fn().mockResolvedValue(undefined);
  const rest = {
    get: vi.fn().mockResolvedValue({ type: ChannelType.DM }),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  return {
    reply,
    defer,
    client: { rest },
    user: { id: senderId, username: "AgentUser", discriminator: "0001" },
    message: { id: "msg-1" },
  };
};

export const createComponentButtonInteraction = (
  overrides: Partial<ButtonInteraction> = {},
  senderId?: string,
) => {
  const base = createComponentInteractionBase(senderId);
  const interaction = {
    rawData: { channel_id: "dm-channel", id: "interaction-1" },
    customId: "occomp:cid=btn_1",
    ...base,
    ...overrides,
  } as unknown as ButtonInteraction;
  return { interaction, defer: base.defer, reply: base.reply };
};

export const createComponentSelectInteraction = (
  overrides: Partial<StringSelectMenuInteraction> = {},
) => {
  const base = createComponentInteractionBase();
  const interaction = {
    rawData: { channel_id: "dm-channel", id: "interaction-select-1" },
    customId: "occomp:cid=sel_1",
    values: ["alpha"],
    ...base,
    ...overrides,
  } as unknown as StringSelectMenuInteraction;
  return { interaction, defer: base.defer, reply: base.reply };
};

export const createModalInteraction = (overrides: Partial<ModalInteraction> = {}) => {
  const reply = vi.fn().mockResolvedValue(undefined);
  const acknowledge = vi.fn().mockResolvedValue(undefined);
  const rest = {
    get: vi.fn().mockResolvedValue({ type: ChannelType.DM }),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const fields = {
    getText: (key: string) => (key === "fld_1" ? "Casey" : undefined),
    getStringSelect: (_key: string) => undefined,
    getRoleSelect: (_key: string) => [],
    getUserSelect: (_key: string) => [],
  };
  const interaction = {
    rawData: { channel_id: "dm-channel", id: "interaction-2" },
    user: { id: "123456789", username: "AgentUser", discriminator: "0001" },
    customId: "ocmodal:mid=mdl_1",
    fields,
    acknowledge,
    reply,
    client: { rest },
    ...overrides,
  } as unknown as ModalInteraction;
  return { interaction, acknowledge, reply };
};

export const createButtonEntry = (
  overrides: Partial<DiscordComponentEntry> = {},
): DiscordComponentEntry => ({
  id: "btn_1",
  kind: "button",
  label: "Approve",
  messageId: "msg-1",
  sessionKey: "session-1",
  agentId: "agent-1",
  accountId: "default",
  ...overrides,
});

export const createModalEntry = (
  overrides: Partial<DiscordModalEntry> = {},
): DiscordModalEntry => ({
  id: "mdl_1",
  title: "Details",
  messageId: "msg-2",
  sessionKey: "session-2",
  agentId: "agent-2",
  accountId: "default",
  fields: [
    {
      id: "fld_1",
      name: "name",
      label: "Name",
      type: "text",
    },
  ],
  ...overrides,
});
