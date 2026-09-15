import {
  ApplicationCommandOptionType,
  ChannelType,
  GuildMemberFlags,
  InteractionResponseType,
  InteractionType,
} from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as sessionStore from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachRestMock,
  createInternalInteractionPayload,
  createInternalComponentInteractionPayload,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import { createDiscordLivePolicyReader } from "./live-policy.js";
import { clearDiscordChannelInfoCacheForTest } from "./message-channel-info.test-support.js";
import * as pickerPreferences from "./model-picker-preferences.js";
import * as pickerState from "./model-picker.state.js";
import { createModelsProviderData } from "./model-picker.test-utils.js";
import {
  createDiscordModelPickerFallbackButton,
  createDiscordNativeCommand,
} from "./native-command.js";
import { nativeCommandRuntime } from "./native-command.runtime.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const GUILD = "100000000000000001";
const CHANNEL = "100000000000000002";
const THREAD = "100000000000000003";
const USER = "100000000000000004";

function createConfig(): OpenClawConfig {
  return {
    commands: { allowFrom: { discord: [`user:${USER}`] } },
    agents: { defaults: { model: { primary: "test-provider/test-model" } } },
    channels: {
      discord: {
        groupPolicy: "allowlist",
        guilds: { [GUILD]: { channels: { [CHANNEL]: { enabled: true } } } },
      },
    },
  };
}

function createHarness() {
  const cfg = createConfig();
  let currentConfig = cfg;
  const readPolicy = createDiscordLivePolicyReader({
    cfg,
    accountId: "default",
    token: "test-token",
    readConfig: () => currentConfig,
    resolvedAllowlist: { guildEntries: cfg.channels?.discord?.guilds, allowFrom: [] },
  });
  const commandContext = {
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    readPolicy,
    accountId: "default",
    sessionPrefix: "discord:slash",
    postApplySettleMs: 0,
    threadBindings: createNoopThreadBindingManager("default"),
  };
  const client = createInternalTestClient([
    createDiscordNativeCommand({
      ...commandContext,
      ephemeralDefault: true,
      command: { name: "status", description: "Status", acceptsArgs: false },
    }),
    createDiscordNativeCommand({
      ...commandContext,
      ephemeralDefault: true,
      command: {
        name: "boundary-choice",
        description: "Choose",
        acceptsArgs: true,
        args: [
          {
            name: "choice",
            description: "Choice",
            type: "string",
            preferAutocomplete: true,
            choices: ({ model }) => [model ?? "unresolved"],
          },
        ],
      },
    }),
  ]);
  client.componentHandler.register(createDiscordModelPickerFallbackButton(commandContext));
  const post = vi.fn(async () => undefined);
  const get = vi.fn(async (path: string) => {
    if (path === `/channels/${THREAD}`) {
      return { id: THREAD, type: ChannelType.PublicThread, parent_id: CHANNEL, name: "topic" };
    }
    if (path === `/channels/${CHANNEL}`) {
      return { id: CHANNEL, type: ChannelType.GuildText, name: "allowed" };
    }
    throw new Error(`Unexpected Discord GET ${path}`);
  });
  const patch = vi.fn(async () => undefined);
  attachRestMock(client, { post, get, patch });
  const session = vi.spyOn(sessionStore, "getSessionEntry").mockReturnValue(undefined);
  vi.spyOn(pickerState, "loadDiscordModelPickerData").mockResolvedValue(
    createModelsProviderData({ "test-provider": ["test-model"] }),
  );
  vi.spyOn(pickerPreferences, "readDiscordModelPickerRecentModels").mockResolvedValue([]);
  const dispatch = vi
    .spyOn(nativeCommandRuntime, "dispatchChannelInboundTurn")
    .mockImplementation(async () => {
      throw new Error("Unexpected agent turn");
    });
  const status = vi
    .spyOn(nativeCommandRuntime, "resolveDirectStatusReplyForSession")
    .mockImplementation(async ({ sessionKey }) => ({ text: `Status for ${sessionKey}` }));
  return {
    client,
    post,
    get,
    status,
    dispatch,
    session,
    patch,
    replacePolicy: () => {
      currentConfig = {
        ...cfg,
        channels: { discord: { groupPolicy: "disabled" } },
      };
    },
  };
}

function payload(channelId: string, hydrated = false, userId = USER) {
  return createInternalInteractionPayload({
    id: "interaction1",
    token: "test-token",
    guild_id: GUILD,
    channel_id: channelId,
    member: {
      user: { id: userId, username: "tester", discriminator: "0", avatar: null, global_name: null },
      roles: [],
      joined_at: "2026-01-01T00:00:00.000Z",
      deaf: false,
      mute: false,
      permissions: "0",
      flags: GuildMemberFlags.CompletedOnboarding,
    },
    ...(hydrated ? { channel: { id: channelId, type: ChannelType.GuildText } } : {}),
    data: { id: "command1", name: "status", type: 1 },
  });
}

function autocompletePayload(channelId: string, hydrated = false, userId = USER) {
  return createInternalInteractionPayload({
    ...payload(channelId, hydrated, userId),
    type: InteractionType.ApplicationCommandAutocomplete,
    data: {
      id: "command2",
      name: "boundary-choice",
      type: 1,
      options: [
        { name: "choice", type: ApplicationCommandOptionType.String, value: "", focused: true },
      ],
    },
  });
}

function pickerPayload(channelId: string, action: "back" | "reset" = "back", userId = USER) {
  return createInternalComponentInteractionPayload({
    ...payload(channelId, false, userId),
    data: {
      custom_id: pickerState.buildDiscordModelPickerCustomId({
        command: "model",
        action,
        view: "providers",
        userId,
      }),
    },
  });
}

function expectVisibleStatus(harness: ReturnType<typeof createHarness>, channelId: string) {
  const sessionKey = `agent:main:discord:channel:${channelId}`;
  expect(harness.status, JSON.stringify(harness.post.mock.calls)).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sessionKey, channel: "discord", senderId: USER, isGroup: true }),
  );
  expect(harness.post).toHaveBeenCalledWith(
    "/webhooks/app1/test-token",
    {
      body: { content: `Status for ${sessionKey}`, flags: 64 },
    },
    undefined,
  );
}

// Isolated boundary proof: REST is controlled; interaction construction, dispatch,
// access policy, conversation routing and response serialization are production code.
describe("Client.handleInteraction native command channel identity", () => {
  beforeEach(() => clearDiscordChannelInfoCacheForTest());
  afterEach(() => vi.restoreAllMocks());

  it("delivers status for a hydrated allowed channel", async () => {
    const harness = createHarness();
    await harness.client.handleInteraction(payload(CHANNEL, true));
    expectVisibleStatus(harness, CHANNEL);
  });

  it.each([CHANNEL, THREAD])(
    "delivers status for raw channel %s without hydration",
    async (channelId) => {
      const harness = createHarness();
      await harness.client.handleInteraction(payload(channelId));
      expectVisibleStatus(harness, channelId);
    },
  );

  it.each([true, false])(
    "rejects a sender outside commands.allowFrom (hydrated=%s)",
    async (hydrated) => {
      const harness = createHarness();
      await harness.client.handleInteraction(payload(CHANNEL, hydrated, "100000000000000099"));
      expect(harness.status).not.toHaveBeenCalled();
      expect(harness.post).toHaveBeenCalledWith(
        "/webhooks/app1/test-token",
        {
          body: { content: "You are not authorized to use this command.", flags: 64 },
        },
        undefined,
      );
    },
  );

  it("rejects a thread whose parent is outside the allowlist", async () => {
    const harness = createHarness();
    harness.get.mockResolvedValue({
      id: THREAD,
      type: ChannelType.PublicThread,
      parent_id: "denied",
      name: "topic",
    });
    await harness.client.handleInteraction(payload(THREAD));
    expect(harness.status).not.toHaveBeenCalled();
    expect(harness.post).toHaveBeenCalledWith(
      "/webhooks/app1/test-token",
      {
        body: { content: "This channel is not allowed.", flags: 64 },
      },
      undefined,
    );
  });

  it("rejects missing channel identity under an allowlist", async () => {
    const harness = createHarness();
    const interaction = payload(CHANNEL);
    Reflect.deleteProperty(interaction, "channel_id");
    await harness.client.handleInteraction(interaction);
    expect(harness.status).not.toHaveBeenCalled();
    expect(harness.post).toHaveBeenCalledWith(
      "/webhooks/app1/test-token",
      {
        body: { content: "This channel is not allowed.", flags: 64 },
      },
      undefined,
    );
  });

  it.each([CHANNEL, THREAD])(
    "autocompletes for raw channel %s through the registered option",
    async (channelId) => {
      const harness = createHarness();
      await harness.client.handleInteraction(autocompletePayload(channelId));
      expect(harness.post).toHaveBeenCalledWith("/interactions/interaction1/test-token/callback", {
        body: {
          type: InteractionResponseType.ApplicationCommandAutocompleteResult,
          data: { choices: [{ name: "test-model", value: "test-model" }] },
        },
      });
      expect(harness.session).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: `agent:main:discord:channel:${channelId}`,
        }),
      );
    },
  );

  it.each([CHANNEL, THREAD])(
    "opens the registered picker for the raw channel %s session",
    async (channelId) => {
      const harness = createHarness();
      await harness.client.handleInteraction(pickerPayload(channelId));
      expect(harness.session).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: `agent:main:discord:channel:${channelId}`,
        }),
      );
      expect(harness.patch).toHaveBeenCalledWith(
        "/webhooks/app1/test-token/messages/%40original",
        expect.objectContaining({
          body: expect.objectContaining({ components: expect.any(Array) }),
        }),
        expect.anything(),
      );
      expect(JSON.stringify(harness.patch.mock.calls)).toContain("test-provider");
    },
  );

  it("rejects a policy replaced while the channel fetch is pending", async () => {
    const harness = createHarness();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    harness.get.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { id: CHANNEL, type: ChannelType.GuildText, name: "allowed" };
    });
    const pending = harness.client.handleInteraction(payload(CHANNEL, true));
    await entered.promise;
    harness.replacePolicy();
    release.resolve();
    await pending;
    expect(harness.status).not.toHaveBeenCalled();
    expect(harness.post).toHaveBeenCalledWith(
      "/webhooks/app1/test-token",
      {
        body: { content: "Access policy changed. Try this interaction again.", flags: 64 },
      },
      undefined,
    );
  });

  it.each(["sender", "parent", "identity"] as const)(
    "denies raw autocomplete with denied %s",
    async (denial) => {
      const harness = createHarness();
      const interaction = autocompletePayload(
        denial === "parent" ? THREAD : CHANNEL,
        false,
        denial === "sender" ? "100000000000000099" : USER,
      );
      if (denial === "parent") {
        harness.get.mockResolvedValue({
          id: THREAD,
          type: ChannelType.PublicThread,
          parent_id: "denied",
          name: "topic",
        });
      }
      if (denial === "identity") {
        Reflect.deleteProperty(interaction, "channel_id");
      }
      await harness.client.handleInteraction(interaction);
      expect(harness.post).toHaveBeenCalledExactlyOnceWith(
        "/interactions/interaction1/test-token/callback",
        {
          body: {
            type: InteractionResponseType.ApplicationCommandAutocompleteResult,
            data: { choices: [] },
          },
        },
      );
      expect(harness.session).not.toHaveBeenCalled();
    },
  );

  it.each(["sender", "parent", "identity"] as const)(
    "denies raw picker selection with denied %s",
    async (denial) => {
      const harness = createHarness();
      const interaction = pickerPayload(
        denial === "parent" ? THREAD : CHANNEL,
        "reset",
        denial === "sender" ? "100000000000000099" : USER,
      );
      if (denial === "parent") {
        harness.get.mockResolvedValue({
          id: THREAD,
          type: ChannelType.PublicThread,
          parent_id: "denied",
          name: "topic",
        });
      }
      if (denial === "identity") {
        Reflect.deleteProperty(interaction, "channel_id");
      }
      await harness.client.handleInteraction(interaction);
      expect(harness.dispatch).not.toHaveBeenCalled();
      expect(JSON.stringify(harness.post.mock.calls)).toContain(
        "Failed to apply test-provider/test-model",
      );
      expect(JSON.stringify(harness.post.mock.calls)).toContain(
        denial === "sender" ? "not authorized" : "not allowed",
      );
    },
  );

  it.each(["status", "autocomplete", "picker"] as const)(
    "denies raw %s when policy changes during the channel fetch",
    async (surface) => {
      const harness = createHarness();
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      harness.get.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { id: CHANNEL, type: ChannelType.GuildText, name: "allowed" };
      });
      const interaction =
        surface === "status"
          ? payload(CHANNEL)
          : surface === "autocomplete"
            ? autocompletePayload(CHANNEL)
            : pickerPayload(CHANNEL, "reset");
      const pending = harness.client.handleInteraction(interaction);
      try {
        const fetched = await Promise.race([
          entered.promise.then(() => true),
          pending.then(() => false),
        ]);
        expect(fetched).toBe(true);
        harness.replacePolicy();
      } finally {
        release.resolve();
        await pending;
      }
      expect(harness.status).not.toHaveBeenCalled();
      expect(harness.dispatch).not.toHaveBeenCalled();
      if (surface === "autocomplete") {
        expect(harness.session).not.toHaveBeenCalled();
        expect(harness.post).toHaveBeenCalledExactlyOnceWith(
          "/interactions/interaction1/test-token/callback",
          {
            body: {
              type: InteractionResponseType.ApplicationCommandAutocompleteResult,
              data: { choices: [] },
            },
          },
        );
      } else {
        expect(JSON.stringify(harness.post.mock.calls)).toContain(
          surface === "status"
            ? "Access policy changed"
            : "Failed to apply test-provider/test-model",
        );
      }
    },
  );
});
