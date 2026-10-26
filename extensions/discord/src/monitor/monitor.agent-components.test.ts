import { ChannelType, ComponentType } from "discord-api-types/v10";
import { expectPairingReplyText } from "openclaw/plugin-sdk/channel-test-helpers";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { logDebug } from "openclaw/plugin-sdk/logging-core";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
} from "openclaw/plugin-sdk/system-event-runtime";
import { peekSystemEvents, resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BaseComponentInteraction,
  createInteraction,
  type ComponentData,
} from "../internal/discord.js";
import {
  createInternalComponentInteractionPayload,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import {
  enqueueSystemEventMock,
  readAllowFromStoreMock,
  resetDiscordComponentRuntimeMocks,
  upsertPairingRequestMock,
} from "../test-support/component-runtime.js";
import {
  createAgentComponentButton,
  createAgentSelectMenu,
} from "./agent-components.system-controls.js";
import { createDiscordLivePolicyReader } from "./live-policy.js";

vi.mock("openclaw/plugin-sdk/logging-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/logging-core")>()),
  logDebug: vi.fn(),
}));

describe("agent components", () => {
  const sessionKey = (peer: Parameters<typeof buildAgentSessionKey>[0]["peer"]) =>
    buildAgentSessionKey({ agentId: "main", channel: "discord", accountId: "default", peer });
  const defaultDmSessionKey = sessionKey({ kind: "direct", id: "123456789" });
  const defaultGroupDmSessionKey = sessionKey({ kind: "group", id: "group-dm-channel" });

  type ControlContext = Parameters<typeof createAgentComponentButton>[0];
  const context = (overrides: Partial<ControlContext> = {}): ControlContext => ({
    cfg: {},
    accountId: "default",
    ...overrides,
  });
  function createControlInteraction(
    interactionId = "interaction-1",
    kind: "button" | "select" | "group" = "button",
  ) {
    const interaction = createInteraction(
      createInternalTestClient(),
      createInternalComponentInteractionPayload({
        id: interactionId,
        token: `token-${interactionId}`,
        channel_id: kind === "group" ? "group-dm-channel" : "dm-channel",
        ...(kind === "group"
          ? {
              channel: { id: "group-dm-channel", type: ChannelType.GroupDM, name: "incident-room" },
            }
          : {}),
        user: {
          id: "123456789",
          username: "Alice",
          discriminator: "1234",
          global_name: null,
          avatar: null,
        },
        ...(kind === "select"
          ? { data: { component_type: ComponentType.StringSelect, values: ["alpha"] } }
          : {}),
      }),
    );
    if (!(interaction instanceof BaseComponentInteraction)) {
      throw new Error(`expected a Discord ${kind} interaction`);
    }
    return {
      interaction,
      defer: vi.spyOn(interaction, "defer").mockResolvedValue(undefined),
      reply: vi.spyOn(interaction, "reply").mockResolvedValue(undefined),
    };
  }
  const createDmButtonInteraction = (id?: string) => createControlInteraction(id);
  const createDmSelectInteraction = (id?: string) => createControlInteraction(id, "select");
  const createGroupDmButtonInteraction = (id?: string) => createControlInteraction(id, "group");

  const firstReplyContent = (reply: ReturnType<typeof vi.fn>): string => {
    const [call] = reply.mock.calls;
    if (!call) {
      throw new Error("expected interaction reply call");
    }
    const [payload] = call;
    if (!payload || typeof payload !== "object" || !("content" in payload)) {
      throw new Error("expected interaction reply content");
    }
    const { content } = payload as { content?: unknown };
    if (typeof content !== "string") {
      throw new Error("expected interaction reply content to be a string");
    }
    return content;
  };

  async function click(
    overrides: Partial<ControlContext>,
    fixture = createDmButtonInteraction(),
    data: ComponentData = { componentId: "hello" } as ComponentData,
  ) {
    await createAgentComponentButton(context(overrides)).run(fixture.interaction, data);
    expect(fixture.defer).not.toHaveBeenCalled();
    return fixture;
  }

  beforeEach(() => {
    resetDiscordComponentRuntimeMocks();
    resetSystemEventsForTest();
    vi.mocked(logDebug).mockClear();
  });

  it("does not create pairing after policy is revoked during the component store read", async () => {
    const cfg: OpenClawConfig = {
      channels: { discord: { dmPolicy: "pairing", allowFrom: [] } },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const stored = createDeferred<string[]>();
    const readStarted = createDeferred<void>();
    readAllowFromStoreMock.mockImplementationOnce(() => {
      readStarted.resolve();
      return stored.promise;
    });
    const button = createAgentComponentButton({
      cfg,
      accountId: "default",
      readPolicy: createDiscordLivePolicyReader({
        cfg,
        accountId: "default",
        token: "synthetic-token",
        resolvedAllowlist: { guildEntries: undefined, allowFrom: [] },
      }),
    });
    const { interaction, reply } = createDmButtonInteraction();
    try {
      const run = button.run(interaction, { componentId: "hello" } as ComponentData);
      await readStarted.promise;
      const revoked: OpenClawConfig = {
        channels: { discord: { dmPolicy: "disabled", allowFrom: [] } },
      };
      setRuntimeConfigSnapshot(revoked, revoked);
      stored.resolve([]);
      await run;

      expect(reply).toHaveBeenCalledExactlyOnceWith({
        content: "Access policy changed. Try this interaction again.",
        ephemeral: true,
      });
      expect(upsertPairingRequestMock).not.toHaveBeenCalled();
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    } finally {
      stored.resolve([]);
      clearRuntimeConfigSnapshot();
    }
  });

  it("sends pairing reply when DM sender is not allowlisted", async () => {
    const { reply } = await click({ dmPolicy: "pairing" });
    expect(reply).toHaveBeenCalledTimes(1);
    const pairingText = firstReplyContent(reply);
    const code = expectPairingReplyText(pairingText, {
      channel: "discord",
      idLine: "Your Discord user id: 123456789",
    });
    expect(pairingText).toContain(`openclaw pairing approve discord ${code}`);
    expect(peekSystemEvents(defaultDmSessionKey)).toStrictEqual([]);
    expect(readAllowFromStoreMock).toHaveBeenCalledWith("discord", "default");
  });

  it.each([
    ["allowlist", false, "You are not authorized to use this button."],
    ["open", true, "You are not authorized to use this button."],
    ["disabled", false, "DM interactions are disabled."],
  ] as const)("blocks %s interactions (group=%s)", async (dmPolicy, group, content) => {
    if (dmPolicy === "disabled") {
      readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    }
    const { reply } = await click(
      {
        dmPolicy,
        ...(group
          ? { discordConfig: { dm: { groupEnabled: true, groupChannels: ["other-group-dm"] } } }
          : {}),
      },
      group ? createGroupDmButtonInteraction() : createDmButtonInteraction(),
    );
    expect(reply).toHaveBeenCalledWith({ content, ephemeral: true });
    expect(peekSystemEvents(defaultDmSessionKey)).toStrictEqual([]);
    if (group) {
      expect(peekSystemEvents(defaultGroupDmSessionKey)).toStrictEqual([]);
    }
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("routes allowlisted Group DM interactions to the group session without applying DM policy", async () => {
    const { reply } = await click(
      {
        dmPolicy: "disabled",
        discordConfig: {
          dm: {
            groupEnabled: true,
            groupChannels: ["group-dm-channel"],
          },
        } as DiscordAccountConfig,
      },
      createGroupDmButtonInteraction(),
    );
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord component: hello clicked by Alice#1234 (123456789)]",
      {
        sessionKey: defaultGroupDmSessionKey,
        contextKey: "discord:agent-button:group-dm-channel:hello:123456789:interaction-1",
      },
    );
    expect(peekSystemEvents(defaultDmSessionKey)).toStrictEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it.each(["pairing", "open"] as const)("authorizes %s DM interactions", async (dmPolicy) => {
    readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    const { reply } = await click({
      dmPolicy,
      ...(dmPolicy === "open" ? { allowFrom: ["*"] } : {}),
    });
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord component: hello clicked by Alice#1234 (123456789)]",
      {
        sessionKey: defaultDmSessionKey,
        contextKey: "discord:agent-button:dm-channel:hello:123456789:interaction-1",
      },
    );
    if (dmPolicy === "pairing") {
      expect(readAllowFromStoreMock).toHaveBeenCalledWith("discord", "default");
      expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    } else {
      expect(readAllowFromStoreMock).not.toHaveBeenCalled();
    }
  });

  it("matches tag-based allowlist entries for DM select menus", async () => {
    const select = createAgentSelectMenu(
      context({
        discordConfig: { dangerouslyAllowNameMatching: true } as DiscordAccountConfig,
        dmPolicy: "allowlist",
        allowFrom: ["Alice#1234"],
      }),
    );
    const { interaction, defer, reply } = createDmSelectInteraction();

    await select.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord select menu: hello interacted by Alice#1234 (123456789) (selected: alpha)]",
      {
        sessionKey: defaultDmSessionKey,
        contextKey: "discord:agent-select:dm-channel:hello:123456789:interaction-1",
      },
    );
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
    const diagnostics = vi.mocked(logDebug).mock.calls.flat().join("\n");
    expect(diagnostics).toContain("interaction=interaction-1");
    expect(diagnostics).not.toContain("alpha");
    expect(diagnostics).not.toContain("Alice");
  });

  it("keeps malformed percent cid values without throwing", async () => {
    const { reply } = await click({ dmPolicy: "allowlist", allowFrom: ["123456789"] }, undefined, {
      cid: "hello%2G",
    } as ComponentData);
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord component: hello%2G clicked by Alice#1234 (123456789)]",
      {
        sessionKey: defaultDmSessionKey,
        contextKey: "discord:agent-button:dm-channel:hello%2G:123456789:interaction-1",
      },
    );
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it.each(["button", "select"] as const)(
    "queues distinct %s occurrences while deduplicating replayed occurrences",
    async (kind) => {
      const ctx = context({ dmPolicy: "allowlist", allowFrom: ["123456789"] });
      const control =
        kind === "button" ? createAgentComponentButton(ctx) : createAgentSelectMenu(ctx);
      const createInteractionForKind =
        kind === "button" ? createDmButtonInteraction : createDmSelectInteraction;
      const first = createInteractionForKind("interaction-1");
      const second = createInteractionForKind("interaction-2");
      const replay = createInteractionForKind("interaction-1");

      await enqueueSystemEventMock.withImplementation(
        (...args) => enqueueSystemEvent(...(args as Parameters<typeof enqueueSystemEvent>)),
        async () => {
          await control.run(first.interaction, { componentId: "hello" } as ComponentData);
          enqueueSystemEvent("An unrelated event occurred", {
            sessionKey: defaultDmSessionKey,
            contextKey: "discord:test:intervening",
          });
          await control.run(second.interaction, { componentId: "hello" } as ComponentData);
          await control.run(replay.interaction, { componentId: "hello" } as ComponentData);

          expect(enqueueSystemEventMock.mock.results.map(({ value }) => value)).toEqual([
            true,
            true,
            false,
          ]);
          const eventText =
            kind === "button"
              ? "[Discord component: hello clicked by Alice#1234 (123456789)]"
              : "[Discord select menu: hello interacted by Alice#1234 (123456789) (selected: alpha)]";
          expect(peekSystemEventEntries(defaultDmSessionKey)).toMatchObject([
            {
              text: eventText,
              contextKey: `discord:agent-${kind}:dm-channel:hello:123456789:interaction-1`,
            },
            {
              text: "An unrelated event occurred",
              contextKey: "discord:test:intervening",
            },
            {
              text: eventText,
              contextKey: `discord:agent-${kind}:dm-channel:hello:123456789:interaction-2`,
            },
          ]);
          for (const { reply } of [first, second, replay]) {
            expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
          }
        },
      );
    },
  );
});
