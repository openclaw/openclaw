/** Tests configured channel-to-ACP binding resolution and generated session keys. */
import { beforeEach, expect, it } from "vitest";
import type { ChannelConfiguredBindingProvider } from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  resolveConfiguredAcpBindingRecord,
  resolveConfiguredAcpBindingSpecBySessionKey,
} from "./persistent-bindings.resolve.js";

type ConfiguredBinding = NonNullable<OpenClawConfig["bindings"]>[number];
type BindingRecordInput = Parameters<typeof resolveConfiguredAcpBindingRecord>[0];

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: { entries: { codex: {}, claude: {} } },
} satisfies OpenClawConfig;

const defaultDiscordConversationId = "1478836151241412759";
const defaultDiscordAccountId = "default";
const model = "anthropic/claude-sonnet-4-6";

const discordBindings: ChannelConfiguredBindingProvider = {
  compileConfiguredBinding: ({ conversationId }) => {
    const normalized = conversationId.trim();
    return normalized ? { conversationId: normalized } : null;
  },
  matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) => {
    if (compiledBinding.conversationId === conversationId) {
      return { conversationId, matchPriority: 2 };
    }
    if (
      parentConversationId &&
      parentConversationId !== conversationId &&
      compiledBinding.conversationId === parentConversationId
    ) {
      return { conversationId: parentConversationId, matchPriority: 1 };
    }
    return null;
  },
};

function createDiscordBinding(params: {
  agentId?: string;
  conversationId?: string;
  accountId?: string;
  acp?: Record<string, unknown>;
}): ConfiguredBinding {
  return {
    type: "acp",
    agentId: params.agentId ?? "codex",
    match: {
      channel: "discord",
      accountId: params.accountId ?? defaultDiscordAccountId,
      peer: { kind: "channel", id: params.conversationId ?? defaultDiscordConversationId },
    },
    ...(params.acp ? { acp: params.acp } : {}),
  } as ConfiguredBinding;
}

function resolveBindingRecord(
  bindings: Parameters<typeof createDiscordBinding>[0][],
  overrides: Partial<BindingRecordInput> = {},
  entries: NonNullable<OpenClawConfig["agents"]>["entries"] = baseCfg.agents.entries,
) {
  return resolveConfiguredAcpBindingRecord({
    cfg: { ...baseCfg, agents: { entries }, bindings: bindings.map(createDiscordBinding) },
    channel: "discord",
    accountId: defaultDiscordAccountId,
    conversationId: defaultDiscordConversationId,
    ...overrides,
  });
}

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        plugin: { ...createChannelTestPluginBase({ id: "discord" }), bindings: discordBindings },
        source: "test",
      },
    ]),
  );
});

it("resolves discord channel ACP binding from top-level typed bindings", () => {
  const resolved = resolveBindingRecord(
    [{ acp: { cwd: "/repo/openclaw" } }],
    {},
    {
      codex: { model: { primary: model } },
    },
  );
  expect(resolved).toMatchObject({
    spec: {
      channel: "discord",
      conversationId: defaultDiscordConversationId,
      agentId: "codex",
      model,
    },
    record: {
      targetSessionKey: expect.stringContaining("agent:codex:acp:binding:discord:default:"),
      metadata: { source: "config" },
    },
  });
});

it("prefers exact account binding over wildcard for the same discord conversation", () => {
  expect(resolveBindingRecord([{ accountId: "*" }, { agentId: "claude" }])?.spec.agentId).toBe(
    "claude",
  );
});

it("returns null when no top-level ACP binding matches the conversation", () => {
  expect(
    resolveBindingRecord([{ conversationId: "different-channel" }], {
      conversationId: "thread-123",
      parentConversationId: "channel-parent-1",
    }),
  ).toBeNull();
});

it("applies agent runtime ACP defaults for bound conversations", () => {
  const entries = {
    main: {},
    coding: {
      runtime: {
        type: "acp",
        acp: {
          agent: "codex",
          backend: "acpx",
          mode: "oneshot",
          cwd: "/workspace/repo-a",
        },
      },
    },
  } satisfies NonNullable<OpenClawConfig["agents"]>["entries"];
  expect(resolveBindingRecord([{ agentId: "coding" }], {}, entries)?.spec).toMatchObject({
    agentId: "coding",
    acpAgentId: "codex",
    mode: "oneshot",
    cwd: "/workspace/repo-a",
    backend: "acpx",
  });
});

it("returns null for unknown session keys", () => {
  expect(
    resolveConfiguredAcpBindingSpecBySessionKey({
      cfg: baseCfg,
      sessionKey: "agent:main:acp:binding:discord:default:notfound",
    }),
  ).toBeNull();
});

it("prefers exact account ACP settings over wildcard when session keys collide", () => {
  const bindings = [{ accountId: "*", acp: { backend: "wild" } }, { acp: { backend: "exact" } }];
  expect(
    resolveConfiguredAcpBindingSpecBySessionKey({
      cfg: { ...baseCfg, bindings: bindings.map(createDiscordBinding) },
      sessionKey: resolveBindingRecord(bindings)?.record.targetSessionKey ?? "",
    })?.backend,
  ).toBe("exact");
});
