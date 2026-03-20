import type {
  ButtonInteraction,
  ComponentData,
  ModalInteraction,
  StringSelectMenuInteraction,
} from "@buape/carbon";
import type { Client } from "@buape/carbon";
import { ChannelType } from "discord-api-types/v10";
import type { GatewayPresenceUpdate } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-runtime";
import { buildPluginBindingApprovalCustomId } from "openclaw/plugin-sdk/conversation-runtime";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDiscordComponentEntries,
  registerDiscordComponentEntries,
  resolveDiscordComponentEntry,
  resolveDiscordModalEntry,
} from "../components-registry.js";
import type { DiscordComponentEntry, DiscordModalEntry } from "../components.js";
import {
  createAgentComponentButton,
  createAgentSelectMenu,
  createDiscordComponentButton,
  createDiscordComponentStringSelect,
  createDiscordComponentModal,
} from "./agent-components.js";
import type { DiscordChannelConfigResolved } from "./allow-list.js";
import {
  resolveDiscordMemberAllowed,
  resolveDiscordOwnerAllowFrom,
  resolveDiscordRoleAllowed,
} from "./allow-list.js";
import {
  clearGateways,
  getGateway,
  registerGateway,
  unregisterGateway,
} from "./gateway-registry.js";
import { clearPresences, getPresence, presenceCacheSize, setPresence } from "./presence-cache.js";
import { resolveDiscordPresenceUpdate } from "./presence.js";
import {
  maybeCreateDiscordAutoThread,
  resolveDiscordAutoThreadContext,
  resolveDiscordAutoThreadReplyPlan,
  resolveDiscordReplyDeliveryPlan,
} from "./threading.js";

const readAllowFromStoreMock = vi.hoisted(() => vi.fn());
const upsertPairingRequestMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
const dispatchReplyMock = vi.hoisted(() => vi.fn());
const recordInboundSessionMock = vi.hoisted(() => vi.fn());
const readSessionUpdatedAtMock = vi.hoisted(() => vi.fn());
const resolveStorePathMock = vi.hoisted(() => vi.fn());
const dispatchPluginInteractiveHandlerMock = vi.hoisted(() => vi.fn());
const resolvePluginConversationBindingApprovalMock = vi.hoisted(() => vi.fn());
const buildPluginBindingResolvedTextMock = vi.hoisted(() => vi.fn());
let lastDispatchCtx: Record<string, unknown> | undefined;

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  return {
    ...actual,
    readStoreAllowFromForDmPolicy: async (params: {
      provider: string;
      accountId: string;
      dmPolicy?: string | null;
      shouldRead?: boolean | null;
    }) => {
      if (params.shouldRead === false || params.dmPolicy === "allowlist") {
        return [];
      }
      return await readAllowFromStoreMock(params.provider, params.accountId);
    },
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
    resolvePluginConversationBindingApproval: (...args: unknown[]) =>
      resolvePluginConversationBindingApprovalMock(...args),
    buildPluginBindingResolvedText: (...args: unknown[]) =>
      buildPluginBindingResolvedTextMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/infra-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/infra-runtime")>();
  return {
    ...actual,
    enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
  return {
    ...actual,
    dispatchReplyWithBufferedBlockDispatcher: (...args: unknown[]) => dispatchReplyMock(...args),
  };
});

// agent-components.ts can bind the core dispatcher via reply-runtime re-exports,
// so keep this direct mock to avoid hitting real embedded-agent dispatch in tests.
vi.mock("../../../../src/auto-reply/reply/provider-dispatcher.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../src/auto-reply/reply/provider-dispatcher.js")
    >();
  return {
    ...actual,
    dispatchReplyWithBufferedBlockDispatcher: (...args: unknown[]) => dispatchReplyMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    recordInboundSession: (...args: unknown[]) => recordInboundSessionMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    readSessionUpdatedAt: (...args: unknown[]) => readSessionUpdatedAtMock(...args),
    resolveStorePath: (...args: unknown[]) => resolveStorePathMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return {
    ...actual,
    dispatchPluginInteractiveHandler: (...args: unknown[]) =>
      dispatchPluginInteractiveHandlerMock(...args),
  };
});

describe("agent components", () => {
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
    readAllowFromStoreMock.mockClear().mockResolvedValue([]);
    upsertPairingRequestMock.mockClear().mockResolvedValue({ code: "PAIRCODE", created: true });
    enqueueSystemEventMock.mockClear();
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
    expect(pairingText).toContain("Pairing code:");
    const code = pairingText.match(/Pairing code:\s*([A-Z2-9]{8})/)?.[1];
    expect(code).toBeDefined();
    expect(pairingText).toContain(`openclaw pairing approve discord ${code}`);
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
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
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
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
    expect(enqueueSystemEventMock).toHaveBeenCalled();
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
    expect(enqueueSystemEventMock).toHaveBeenCalled();
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
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
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
    expect(enqueueSystemEventMock).toHaveBeenCalled();
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
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("hello_cid"),
      expect.any(Object),
    );
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
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("hello%2G"),
      expect.any(Object),
    );
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });
});

describe("discord component interactions", () => {
  const createCfg = (): OpenClawConfig =>
    ({
      channels: {
        discord: {
          replyToMode: "first",
        },
      },
    }) as OpenClawConfig;

  const createDiscordConfig = (overrides?: Partial<DiscordAccountConfig>): DiscordAccountConfig =>
    ({
      replyToMode: "first",
      ...overrides,
    }) as DiscordAccountConfig;

  type DispatchParams = {
    ctx: Record<string, unknown>;
    dispatcherOptions: {
      deliver: (payload: { text?: string }) => Promise<void> | void;
    };
  };

  const createComponentContext = (
    overrides?: Partial<Parameters<typeof createDiscordComponentButton>[0]>,
  ) =>
    ({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["123456789"],
      discordConfig: createDiscordConfig(),
      token: "token",
      ...overrides,
    }) as Parameters<typeof createDiscordComponentButton>[0];

  const createComponentButtonInteraction = (overrides: Partial<ButtonInteraction> = {}) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const defer = vi.fn().mockResolvedValue(undefined);
    const rest = {
      get: vi.fn().mockResolvedValue({ type: ChannelType.DM }),
      post: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const interaction = {
      rawData: { channel_id: "dm-channel", id: "interaction-1" },
      user: { id: "123456789", username: "AgentUser", discriminator: "0001" },
      customId: "occomp:cid=btn_1",
      message: { id: "msg-1" },
      client: { rest },
      defer,
      reply,
      ...overrides,
    } as unknown as ButtonInteraction;
    return { interaction, defer, reply };
  };

  const createComponentSelectInteraction = (
    overrides: Partial<StringSelectMenuInteraction> = {},
  ) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const defer = vi.fn().mockResolvedValue(undefined);
    const rest = {
      get: vi.fn().mockResolvedValue({ type: ChannelType.DM }),
      post: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const interaction = {
      rawData: { channel_id: "dm-channel", id: "interaction-select-1" },
      user: { id: "123456789", username: "AgentUser", discriminator: "0001" },
      customId: "occomp:cid=sel_1",
      message: { id: "msg-1" },
      values: ["alpha"],
      client: { rest },
      defer,
      reply,
      ...overrides,
    } as unknown as StringSelectMenuInteraction;
    return { interaction, defer, reply };
  };

  const createModalInteraction = (overrides: Partial<ModalInteraction> = {}) => {
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

  const createButtonEntry = (
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

  const createModalEntry = (overrides: Partial<DiscordModalEntry> = {}): DiscordModalEntry => ({
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

  beforeEach(() => {
    clearDiscordComponentEntries();
    lastDispatchCtx = undefined;
    readAllowFromStoreMock.mockClear().mockResolvedValue([]);
    upsertPairingRequestMock.mockClear().mockResolvedValue({ code: "PAIRCODE", created: true });
    enqueueSystemEventMock.mockClear();
    dispatchReplyMock.mockClear().mockImplementation(async (params: DispatchParams) => {
      lastDispatchCtx = params.ctx;
      await params.dispatcherOptions.deliver({ text: "ok" });
    });
    recordInboundSessionMock.mockClear().mockResolvedValue(undefined);
    readSessionUpdatedAtMock.mockClear().mockReturnValue(undefined);
    resolveStorePathMock.mockClear().mockReturnValue("/tmp/openclaw-sessions-test.json");
    dispatchPluginInteractiveHandlerMock.mockReset().mockResolvedValue({
      matched: false,
      handled: false,
      duplicate: false,
    });
    resolvePluginConversationBindingApprovalMock.mockReset().mockResolvedValue({
      status: "approved",
      binding: {
        bindingId: "binding-1",
        pluginId: "openclaw-codex-app-server",
        pluginName: "OpenClaw App Server",
        pluginRoot: "/plugins/codex",
        channel: "discord",
        accountId: "default",
        conversationId: "user:123456789",
        boundAt: Date.now(),
      },
      request: {
        id: "approval-1",
        pluginId: "openclaw-codex-app-server",
        pluginName: "OpenClaw App Server",
        pluginRoot: "/plugins/codex",
        requestedAt: Date.now(),
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "user:123456789",
        },
      },
      decision: "allow-once",
    });
    buildPluginBindingResolvedTextMock.mockReset().mockReturnValue("Binding approved.");
  });

  it("routes button clicks with reply references", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry()],
      modals: [],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction, reply } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(lastDispatchCtx?.BodyForAgent).toBe('Clicked "Approve".');
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    expect(resolveDiscordComponentEntry({ id: "btn_1" })).toBeNull();
  });

  it("uses raw callbackData for built-in fallback when no plugin handler matches", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ callbackData: "/codex_resume --browse-projects" })],
      modals: [],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction, reply } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(lastDispatchCtx?.BodyForAgent).toBe("/codex_resume --browse-projects");
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
  });

  it("preserves selected values for select fallback when no plugin handler matches", async () => {
    registerDiscordComponentEntries({
      entries: [
        {
          id: "sel_1",
          kind: "select",
          label: "Pick",
          messageId: "msg-1",
          sessionKey: "session-1",
          agentId: "agent-1",
          accountId: "default",
          callbackData: "/codex_resume",
          selectType: "string",
          options: [{ value: "alpha", label: "Alpha" }],
        },
      ],
      modals: [],
    });

    const select = createDiscordComponentStringSelect(createComponentContext());
    const { interaction, reply } = createComponentSelectInteraction();

    await select.run(interaction, { cid: "sel_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(lastDispatchCtx?.BodyForAgent).toBe('Selected Alpha from "Pick".');
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
  });

  it("keeps reusable buttons active after use", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ reusable: true })],
      modals: [],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction } = createComponentButtonInteraction();
    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    const { interaction: secondInteraction } = createComponentButtonInteraction({
      rawData: {
        channel_id: "dm-channel",
        id: "interaction-2",
      } as unknown as ButtonInteraction["rawData"],
    });
    await button.run(secondInteraction, { cid: "btn_1" } as ComponentData);

    expect(dispatchReplyMock).toHaveBeenCalledTimes(2);
    expect(resolveDiscordComponentEntry({ id: "btn_1", consume: false })).not.toBeNull();
  });

  it("blocks buttons when allowedUsers does not match", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ allowedUsers: ["999"] })],
      modals: [],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction, reply } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(dispatchReplyMock).not.toHaveBeenCalled();
    expect(resolveDiscordComponentEntry({ id: "btn_1", consume: false })).not.toBeNull();
  });

  async function runModalSubmission(params?: { reusable?: boolean }) {
    registerDiscordComponentEntries({
      entries: [],
      modals: [createModalEntry({ reusable: params?.reusable ?? false })],
    });

    const modal = createDiscordComponentModal(
      createComponentContext({
        discordConfig: createDiscordConfig({ replyToMode: "all" }),
      }),
    );
    const { interaction, acknowledge } = createModalInteraction();

    await modal.run(interaction, { mid: "mdl_1" } as ComponentData);
    return { acknowledge };
  }

  it("routes modal submissions with field values", async () => {
    const { acknowledge } = await runModalSubmission();

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(lastDispatchCtx?.BodyForAgent).toContain('Form "Details" submitted.');
    expect(lastDispatchCtx?.BodyForAgent).toContain("- Name: Casey");
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    expect(resolveDiscordModalEntry({ id: "mdl_1" })).toBeNull();
  });

  it("does not mark guild modal events as command-authorized for non-allowlisted users", async () => {
    registerDiscordComponentEntries({
      entries: [],
      modals: [createModalEntry()],
    });

    const modal = createDiscordComponentModal(
      createComponentContext({
        cfg: {
          commands: { useAccessGroups: true },
          channels: { discord: { replyToMode: "first" } },
        } as OpenClawConfig,
        allowFrom: ["owner-1"],
      }),
    );
    const { interaction, acknowledge } = createModalInteraction({
      rawData: {
        channel_id: "guild-channel",
        guild_id: "guild-1",
        id: "interaction-guild-1",
        member: { roles: [] },
      } as unknown as ModalInteraction["rawData"],
      guild: { id: "guild-1", name: "Test Guild" } as unknown as ModalInteraction["guild"],
    });

    await modal.run(interaction, { mid: "mdl_1" } as ComponentData);

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    expect(lastDispatchCtx?.CommandAuthorized).toBe(false);
  });

  it("marks guild modal events as command-authorized for allowlisted users", async () => {
    registerDiscordComponentEntries({
      entries: [],
      modals: [createModalEntry()],
    });

    const modal = createDiscordComponentModal(
      createComponentContext({
        cfg: {
          commands: { useAccessGroups: true },
          channels: { discord: { replyToMode: "first" } },
        } as OpenClawConfig,
        allowFrom: ["123456789"],
      }),
    );
    const { interaction, acknowledge } = createModalInteraction({
      rawData: {
        channel_id: "guild-channel",
        guild_id: "guild-1",
        id: "interaction-guild-2",
        member: { roles: [] },
      } as unknown as ModalInteraction["rawData"],
      guild: { id: "guild-1", name: "Test Guild" } as unknown as ModalInteraction["guild"],
    });

    await modal.run(interaction, { mid: "mdl_1" } as ComponentData);

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    expect(lastDispatchCtx?.CommandAuthorized).toBe(true);
  });

  it("keeps reusable modal entries active after submission", async () => {
    const { acknowledge } = await runModalSubmission({ reusable: true });

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(resolveDiscordModalEntry({ id: "mdl_1", consume: false })).not.toBeNull();
  });

  it("passes false auth to plugin Discord interactions for non-allowlisted guild users", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ callbackData: "codex:approve" })],
      modals: [],
    });
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      matched: true,
      handled: true,
      duplicate: false,
    });

    const button = createDiscordComponentButton(
      createComponentContext({
        cfg: {
          commands: { useAccessGroups: true },
          channels: { discord: { replyToMode: "first" } },
        } as OpenClawConfig,
        allowFrom: ["owner-1"],
      }),
    );
    const { interaction } = createComponentButtonInteraction({
      rawData: {
        channel_id: "guild-channel",
        guild_id: "guild-1",
        id: "interaction-guild-plugin-1",
        member: { roles: [] },
      } as unknown as ButtonInteraction["rawData"],
      guild: { id: "guild-1", name: "Test Guild" } as unknown as ButtonInteraction["guild"],
    });

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          auth: { isAuthorizedSender: false },
        }),
      }),
    );
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });

  it("passes true auth to plugin Discord interactions for allowlisted guild users", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ callbackData: "codex:approve" })],
      modals: [],
    });
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      matched: true,
      handled: true,
      duplicate: false,
    });

    const button = createDiscordComponentButton(
      createComponentContext({
        cfg: {
          commands: { useAccessGroups: true },
          channels: { discord: { replyToMode: "first" } },
        } as OpenClawConfig,
        allowFrom: ["123456789"],
      }),
    );
    const { interaction } = createComponentButtonInteraction({
      rawData: {
        channel_id: "guild-channel",
        guild_id: "guild-1",
        id: "interaction-guild-plugin-2",
        member: { roles: [] },
      } as unknown as ButtonInteraction["rawData"],
      guild: { id: "guild-1", name: "Test Guild" } as unknown as ButtonInteraction["guild"],
    });

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          auth: { isAuthorizedSender: true },
        }),
      }),
    );
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });

  it("routes plugin Discord interactions in group DMs by channel id instead of sender id", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ callbackData: "codex:approve" })],
      modals: [],
    });
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      matched: true,
      handled: true,
      duplicate: false,
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction } = createComponentButtonInteraction({
      rawData: {
        channel_id: "group-dm-1",
        id: "interaction-group-dm-1",
      } as unknown as ButtonInteraction["rawData"],
      channel: {
        id: "group-dm-1",
        type: ChannelType.GroupDM,
      } as unknown as ButtonInteraction["channel"],
    });

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          conversationId: "channel:group-dm-1",
          senderId: "123456789",
        }),
      }),
    );
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });

  it("does not fall through to Claw when a plugin Discord interaction already replied", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ callbackData: "codex:approve" })],
      modals: [],
    });
    dispatchPluginInteractiveHandlerMock.mockImplementation(async (params: any) => {
      await params.respond.reply({ text: "✓", ephemeral: true });
      return {
        matched: true,
        handled: true,
        duplicate: false,
      };
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction, reply } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });

  it("falls through to built-in Discord component routing when a plugin declines handling", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ callbackData: "codex:approve" })],
      modals: [],
    });
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      matched: true,
      handled: false,
      duplicate: false,
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction, reply } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
  });

  it("resolves plugin binding approvals without falling through to Claw", async () => {
    registerDiscordComponentEntries({
      entries: [
        createButtonEntry({
          callbackData: buildPluginBindingApprovalCustomId("approval-1", "allow-once"),
        }),
      ],
      modals: [],
    });
    const button = createDiscordComponentButton(createComponentContext());
    const update = vi.fn().mockResolvedValue(undefined);
    const followUp = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      ...(createComponentButtonInteraction().interaction as any),
      update,
      followUp,
    } as ButtonInteraction;

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(update).toHaveBeenCalledWith({ components: [] });
    expect(followUp).toHaveBeenCalledWith({
      content: expect.stringContaining("bind approval"),
      ephemeral: true,
    });
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });
});

describe("resolveDiscordOwnerAllowFrom", () => {
  it("returns undefined when no allowlist is configured", () => {
    const result = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true } as DiscordChannelConfigResolved,
      sender: { id: "123" },
    });

    expect(result).toBeUndefined();
  });

  it("skips wildcard matches for owner allowFrom", () => {
    const result = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true, users: ["*"] } as DiscordChannelConfigResolved,
      sender: { id: "123" },
    });

    expect(result).toBeUndefined();
  });

  it("returns a matching user id entry", () => {
    const result = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true, users: ["123"] } as DiscordChannelConfigResolved,
      sender: { id: "123" },
    });

    expect(result).toEqual(["123"]);
  });

  it("returns the normalized name slug for name matches only when enabled", () => {
    const defaultResult = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true, users: ["Some User"] } as DiscordChannelConfigResolved,
      sender: { id: "999", name: "Some User" },
    });
    expect(defaultResult).toBeUndefined();

    const enabledResult = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true, users: ["Some User"] } as DiscordChannelConfigResolved,
      sender: { id: "999", name: "Some User" },
      allowNameMatching: true,
    });

    expect(enabledResult).toEqual(["some-user"]);
  });
});

describe("resolveDiscordRoleAllowed", () => {
  it("allows when no role allowlist is configured", () => {
    const allowed = resolveDiscordRoleAllowed({
      allowList: undefined,
      memberRoleIds: ["role-1"],
    });

    expect(allowed).toBe(true);
  });

  it("matches role IDs only", () => {
    const allowed = resolveDiscordRoleAllowed({
      allowList: ["123"],
      memberRoleIds: ["123", "456"],
    });

    expect(allowed).toBe(true);
  });

  it("does not match non-ID role entries", () => {
    const allowed = resolveDiscordRoleAllowed({
      allowList: ["Admin"],
      memberRoleIds: ["Admin"],
    });

    expect(allowed).toBe(false);
  });

  it("returns false when no matching role IDs", () => {
    const allowed = resolveDiscordRoleAllowed({
      allowList: ["456"],
      memberRoleIds: ["123"],
    });

    expect(allowed).toBe(false);
  });
});

describe("resolveDiscordMemberAllowed", () => {
  it("allows when no user or role allowlists are configured", () => {
    const allowed = resolveDiscordMemberAllowed({
      userAllowList: undefined,
      roleAllowList: undefined,
      memberRoleIds: [],
      userId: "u1",
    });

    expect(allowed).toBe(true);
  });

  it("allows when user allowlist matches", () => {
    const allowed = resolveDiscordMemberAllowed({
      userAllowList: ["123"],
      roleAllowList: ["456"],
      memberRoleIds: ["999"],
      userId: "123",
    });

    expect(allowed).toBe(true);
  });

  it("allows when role allowlist matches", () => {
    const allowed = resolveDiscordMemberAllowed({
      userAllowList: ["999"],
      roleAllowList: ["456"],
      memberRoleIds: ["456"],
      userId: "123",
    });

    expect(allowed).toBe(true);
  });

  it("denies when user and role allowlists do not match", () => {
    const allowed = resolveDiscordMemberAllowed({
      userAllowList: ["u2"],
      roleAllowList: ["role-2"],
      memberRoleIds: ["role-1"],
      userId: "u1",
    });

    expect(allowed).toBe(false);
  });
});

describe("gateway-registry", () => {
  type GatewayPlugin = { isConnected: boolean };

  function fakeGateway(props: Partial<GatewayPlugin> = {}): GatewayPlugin {
    return { isConnected: true, ...props };
  }

  beforeEach(() => {
    clearGateways();
  });

  it("stores and retrieves a gateway by account", () => {
    const gateway = fakeGateway();
    registerGateway("account-a", gateway as never);
    expect(getGateway("account-a")).toBe(gateway);
    expect(getGateway("account-b")).toBeUndefined();
  });

  it("uses collision-safe key when accountId is undefined", () => {
    const gateway = fakeGateway();
    registerGateway(undefined, gateway as never);
    expect(getGateway(undefined)).toBe(gateway);
    expect(getGateway("default")).toBeUndefined();
  });

  it("unregisters a gateway", () => {
    const gateway = fakeGateway();
    registerGateway("account-a", gateway as never);
    unregisterGateway("account-a");
    expect(getGateway("account-a")).toBeUndefined();
  });

  it("clears all gateways", () => {
    registerGateway("a", fakeGateway() as never);
    registerGateway("b", fakeGateway() as never);
    clearGateways();
    expect(getGateway("a")).toBeUndefined();
    expect(getGateway("b")).toBeUndefined();
  });

  it("overwrites existing entry for same account", () => {
    const gateway1 = fakeGateway({ isConnected: true });
    const gateway2 = fakeGateway({ isConnected: false });
    registerGateway("account-a", gateway1 as never);
    registerGateway("account-a", gateway2 as never);
    expect(getGateway("account-a")).toBe(gateway2);
  });
});

describe("presence-cache", () => {
  beforeEach(() => {
    clearPresences();
  });

  it("scopes presence entries by account", () => {
    const presenceA = { status: "online" } as GatewayPresenceUpdate;
    const presenceB = { status: "idle" } as GatewayPresenceUpdate;

    setPresence("account-a", "user-1", presenceA);
    setPresence("account-b", "user-1", presenceB);

    expect(getPresence("account-a", "user-1")).toBe(presenceA);
    expect(getPresence("account-b", "user-1")).toBe(presenceB);
    expect(getPresence("account-a", "user-2")).toBeUndefined();
  });

  it("clears presence per account", () => {
    const presence = { status: "dnd" } as GatewayPresenceUpdate;

    setPresence("account-a", "user-1", presence);
    setPresence("account-b", "user-2", presence);

    clearPresences("account-a");

    expect(getPresence("account-a", "user-1")).toBeUndefined();
    expect(getPresence("account-b", "user-2")).toBe(presence);
    expect(presenceCacheSize()).toBe(1);
  });
});

describe("resolveDiscordPresenceUpdate", () => {
  it("returns default online presence when no presence config provided", () => {
    expect(resolveDiscordPresenceUpdate({})).toEqual({
      status: "online",
      activities: [],
      since: null,
      afk: false,
    });
  });

  it("returns status-only presence when activity is omitted", () => {
    const presence = resolveDiscordPresenceUpdate({ status: "dnd" });
    expect(presence).not.toBeNull();
    expect(presence?.status).toBe("dnd");
    expect(presence?.activities).toEqual([]);
  });

  it("defaults to custom activity type when activity is set without type", () => {
    const presence = resolveDiscordPresenceUpdate({ activity: "Focus time" });
    expect(presence).not.toBeNull();
    expect(presence?.status).toBe("online");
    expect(presence?.activities).toHaveLength(1);
    expect(presence?.activities[0]).toMatchObject({
      type: 4,
      name: "Custom Status",
      state: "Focus time",
    });
  });

  it("includes streaming url when activityType is streaming", () => {
    const presence = resolveDiscordPresenceUpdate({
      activity: "Live",
      activityType: 1,
      activityUrl: "https://twitch.tv/openclaw",
    });
    expect(presence).not.toBeNull();
    expect(presence?.activities).toHaveLength(1);
    expect(presence?.activities[0]).toMatchObject({
      type: 1,
      name: "Live",
      url: "https://twitch.tv/openclaw",
    });
  });
});

describe("resolveDiscordAutoThreadContext", () => {
  it("returns null without a created thread and re-keys context when present", () => {
    const cases = [
      {
        name: "no created thread",
        createdThreadId: undefined,
        expectedNull: true,
      },
      {
        name: "created thread",
        createdThreadId: "thread",
        expectedNull: false,
      },
    ] as const;

    for (const testCase of cases) {
      const context = resolveDiscordAutoThreadContext({
        agentId: "agent",
        channel: "discord",
        messageChannelId: "parent",
        createdThreadId: testCase.createdThreadId,
      });

      if (testCase.expectedNull) {
        expect(context, testCase.name).toBeNull();
        continue;
      }

      expect(context, testCase.name).not.toBeNull();
      expect(context?.To, testCase.name).toBe("channel:thread");
      expect(context?.From, testCase.name).toBe("discord:channel:thread");
      expect(context?.OriginatingTo, testCase.name).toBe("channel:thread");
      expect(context?.SessionKey, testCase.name).toBe(
        buildAgentSessionKey({
          agentId: "agent",
          channel: "discord",
          peer: { kind: "channel", id: "thread" },
        }),
      );
      expect(context?.ParentSessionKey, testCase.name).toBe(
        buildAgentSessionKey({
          agentId: "agent",
          channel: "discord",
          peer: { kind: "channel", id: "parent" },
        }),
      );
    }
  });
});

describe("resolveDiscordReplyDeliveryPlan", () => {
  it("applies delivery targets and reply reference behavior across thread modes", () => {
    const cases = [
      {
        name: "original target with reply references",
        input: {
          replyTarget: "channel:parent" as const,
          replyToMode: "all" as const,
          messageId: "m1",
          threadChannel: null,
          createdThreadId: null,
        },
        expectedDeliverTarget: "channel:parent",
        expectedReplyTarget: "channel:parent",
        expectedReplyReferenceCalls: ["m1"],
      },
      {
        name: "created thread disables reply references",
        input: {
          replyTarget: "channel:parent" as const,
          replyToMode: "all" as const,
          messageId: "m1",
          threadChannel: null,
          createdThreadId: "thread",
        },
        expectedDeliverTarget: "channel:thread",
        expectedReplyTarget: "channel:thread",
        expectedReplyReferenceCalls: [undefined],
      },
      {
        name: "thread + off mode",
        input: {
          replyTarget: "channel:thread" as const,
          replyToMode: "off" as const,
          messageId: "m1",
          threadChannel: { id: "thread" },
          createdThreadId: null,
        },
        expectedDeliverTarget: "channel:thread",
        expectedReplyTarget: "channel:thread",
        expectedReplyReferenceCalls: [undefined],
      },
      {
        name: "thread + all mode",
        input: {
          replyTarget: "channel:thread" as const,
          replyToMode: "all" as const,
          messageId: "m1",
          threadChannel: { id: "thread" },
          createdThreadId: null,
        },
        expectedDeliverTarget: "channel:thread",
        expectedReplyTarget: "channel:thread",
        expectedReplyReferenceCalls: ["m1", "m1"],
      },
      {
        name: "thread + first mode",
        input: {
          replyTarget: "channel:thread" as const,
          replyToMode: "first" as const,
          messageId: "m1",
          threadChannel: { id: "thread" },
          createdThreadId: null,
        },
        expectedDeliverTarget: "channel:thread",
        expectedReplyTarget: "channel:thread",
        expectedReplyReferenceCalls: ["m1", undefined],
      },
    ] as const;

    for (const testCase of cases) {
      const plan = resolveDiscordReplyDeliveryPlan(testCase.input);
      expect(plan.deliverTarget, testCase.name).toBe(testCase.expectedDeliverTarget);
      expect(plan.replyTarget, testCase.name).toBe(testCase.expectedReplyTarget);
      for (const expected of testCase.expectedReplyReferenceCalls) {
        expect(plan.replyReference.use(), testCase.name).toBe(expected);
      }
    }
  });
});

describe("maybeCreateDiscordAutoThread", () => {
  function createAutoThreadParams(client: Client) {
    return {
      client,
      message: {
        id: "m1",
        channelId: "parent",
      } as unknown as import("./listeners.js").DiscordMessageEvent["message"],
      isGuildMessage: true,
      channelConfig: {
        autoThread: true,
      } as unknown as DiscordChannelConfigResolved,
      threadChannel: null,
      baseText: "hello",
      combinedBody: "hello",
    };
  }

  it("handles create-thread failures with and without an existing thread", async () => {
    const cases = [
      {
        name: "race condition returns existing thread",
        postError: "A thread has already been created on this message",
        getResponse: { thread: { id: "existing-thread" } },
        expected: "existing-thread",
      },
      {
        name: "other error returns undefined",
        postError: "Some other error",
        getResponse: { thread: null },
        expected: undefined,
      },
    ] as const;

    for (const testCase of cases) {
      const client = {
        rest: {
          post: async () => {
            throw new Error(testCase.postError);
          },
          get: async () => testCase.getResponse,
        },
      } as unknown as Client;

      const result = await maybeCreateDiscordAutoThread(createAutoThreadParams(client));
      expect(result, testCase.name).toBe(testCase.expected);
    }
  });
});

describe("resolveDiscordAutoThreadReplyPlan", () => {
  function createAutoThreadPlanParams(overrides?: {
    client?: Client;
    channelConfig?: DiscordChannelConfigResolved;
    threadChannel?: { id: string } | null;
  }) {
    return {
      client:
        overrides?.client ??
        ({ rest: { post: async () => ({ id: "thread" }) } } as unknown as Client),
      message: {
        id: "m1",
        channelId: "parent",
      } as unknown as import("./listeners.js").DiscordMessageEvent["message"],
      isGuildMessage: true,
      channelConfig:
        overrides?.channelConfig ??
        ({ autoThread: true } as unknown as DiscordChannelConfigResolved),
      threadChannel: overrides?.threadChannel ?? null,
      baseText: "hello",
      combinedBody: "hello",
      replyToMode: "all" as const,
      agentId: "agent",
      channel: "discord" as const,
    };
  }

  it("applies auto-thread reply planning across created, existing, and disabled modes", async () => {
    const cases = [
      {
        name: "created thread",
        params: undefined,
        expectedDeliverTarget: "channel:thread",
        expectedReplyReference: undefined,
        expectedSessionKey: buildAgentSessionKey({
          agentId: "agent",
          channel: "discord",
          peer: { kind: "channel", id: "thread" },
        }),
      },
      {
        name: "existing thread channel",
        params: {
          threadChannel: { id: "thread" },
        },
        expectedDeliverTarget: "channel:thread",
        expectedReplyReference: "m1",
        expectedSessionKey: null,
      },
      {
        name: "autoThread disabled",
        params: {
          channelConfig: { autoThread: false } as unknown as DiscordChannelConfigResolved,
        },
        expectedDeliverTarget: "channel:parent",
        expectedReplyReference: "m1",
        expectedSessionKey: null,
      },
    ] as const;

    for (const testCase of cases) {
      const plan = await resolveDiscordAutoThreadReplyPlan(
        createAutoThreadPlanParams(testCase.params),
      );
      expect(plan.deliverTarget, testCase.name).toBe(testCase.expectedDeliverTarget);
      expect(plan.replyReference.use(), testCase.name).toBe(testCase.expectedReplyReference);
      if (testCase.expectedSessionKey == null) {
        expect(plan.autoThreadContext, testCase.name).toBeNull();
      } else {
        expect(plan.autoThreadContext?.SessionKey, testCase.name).toBe(testCase.expectedSessionKey);
      }
    }
  });
});
