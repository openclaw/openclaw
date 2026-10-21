import { ChannelType } from "discord-api-types/v10";
import { vi } from "vitest";
import type { DiscordComponentEntry, DiscordModalEntry } from "../components.js";
import type { BaseComponentInteraction, ModalInteraction } from "../internal/discord.js";

const createInteractionBase = (senderId = "123456789") => ({
  reply: vi.fn().mockResolvedValue(undefined),
  client: {
    rest: {
      get: vi.fn().mockResolvedValue({ type: ChannelType.DM }),
      post: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  },
  user: { id: senderId, username: "AgentUser", discriminator: "0001" },
});

export const createComponentButtonInteraction = (
  overrides: Partial<BaseComponentInteraction> = {},
  senderId?: string,
) => {
  const base = createInteractionBase(senderId);
  const defer = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    rawData: { channel_id: "dm-channel", id: "interaction-1" },
    customId: "occomp:cid=btn_1",
    defer,
    message: { id: "msg-1" },
    ...base,
    ...overrides,
  } as unknown as BaseComponentInteraction;
  return { interaction, defer, reply: base.reply };
};

export const createComponentSelectInteraction = (
  overrides: Partial<BaseComponentInteraction> = {},
) =>
  createComponentButtonInteraction({
    rawData: {
      channel_id: "dm-channel",
      id: "interaction-select-1",
    } as BaseComponentInteraction["rawData"],
    customId: "occomp:cid=sel_1",
    values: ["alpha"],
    ...overrides,
  });

export const createModalInteraction = (overrides: Partial<ModalInteraction> = {}) => {
  const base = createInteractionBase();
  const acknowledge = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    ...base,
    rawData: { channel_id: "dm-channel", id: "interaction-2" },
    customId: "ocmodal:mid=mdl_1",
    acknowledge,
    fields: {
      getText: (key: string) => (key === "fld_1" ? "Casey" : undefined),
      getStringSelect: (_key: string) => undefined,
      getRoleSelect: (_key: string) => [],
      getUserSelect: (_key: string) => [],
    },
    ...overrides,
  } as unknown as ModalInteraction;
  return { interaction, acknowledge, reply: base.reply };
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
  fields: [{ id: "fld_1", name: "name", label: "Name", type: "text" }],
  ...overrides,
});
