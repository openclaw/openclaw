/** Tests configured channel-to-ACP binding resolution and generated session keys. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelConfiguredBindingProvider } from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import type { AcpSessionResolution } from "./control-plane/manager.types.js";
import { ensureConfiguredAcpBindingSession } from "./persistent-bindings.lifecycle.js";
import {
  resolveConfiguredAcpBindingRecord,
  resolveConfiguredAcpBindingSpecBySessionKey,
} from "./persistent-bindings.resolve.js";
import {
  buildConfiguredAcpSessionKey,
  type ConfiguredAcpBindingSpec,
} from "./persistent-bindings.types.js";

const manager = vi.hoisted(() => ({
  resolveSessionAsync: vi.fn<(params: { sessionKey: string }) => Promise<AcpSessionResolution>>(),
  closeSession: vi.fn(),
  initializeSession: vi.fn(),
  setSessionConfigOption: vi.fn(),
}));
// mock-isolation: lifecycle assertions must not create real ACP sessions or workers.
vi.mock("./control-plane/manager.js", () => ({ getAcpSessionManager: () => manager }));

type ConfiguredBinding = NonNullable<OpenClawConfig["bindings"]>[number];
type BindingRecordInput = Parameters<typeof resolveConfiguredAcpBindingRecord>[0];

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: { entries: { codex: {}, claude: {} } },
} satisfies OpenClawConfig;

const defaultDiscordConversationId = "1478836151241412759";
const defaultDiscordAccountId = "default";

const discordBindings: ChannelConfiguredBindingProvider = {
  compileConfiguredBinding: ({ conversationId }) => {
    const normalized = conversationId.trim();
    return normalized ? { conversationId: normalized } : null;
  },
  matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) => {
    const index = [conversationId, parentConversationId].indexOf(compiledBinding.conversationId);
    return index < 0
      ? null
      : { conversationId: compiledBinding.conversationId, matchPriority: 2 - index };
  },
};

function createCfgWithBindings(
  bindings: ConfiguredBinding[],
  entries?: NonNullable<OpenClawConfig["agents"]>["entries"],
): OpenClawConfig {
  return { ...baseCfg, ...(entries ? { agents: { entries } } : {}), bindings } as OpenClawConfig;
}

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

function resolveBindingRecord(cfg: OpenClawConfig, overrides: Partial<BindingRecordInput> = {}) {
  return resolveConfiguredAcpBindingRecord({
    cfg,
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

describe("resolveConfiguredAcpBindingRecord", () => {
  it("resolves discord channel ACP binding from top-level typed bindings", () => {
    const cfg = createCfgWithBindings([createDiscordBinding({ acp: { cwd: "/repo/openclaw" } })], {
      codex: { model: { primary: "anthropic/claude-sonnet-4-6" } },
    });
    const resolved = resolveBindingRecord(cfg);

    expect(resolved?.spec).toMatchObject({
      channel: "discord",
      conversationId: defaultDiscordConversationId,
      agentId: "codex",
      model: "anthropic/claude-sonnet-4-6",
    });
    expect(resolved?.record.targetSessionKey).toContain("agent:codex:acp:binding:discord:default:");
    expect(resolved?.record.metadata?.source).toBe("config");
  });

  it("prefers exact account binding over wildcard for the same discord conversation", () => {
    const cfg = createCfgWithBindings([
      createDiscordBinding({ accountId: "*" }),
      createDiscordBinding({ agentId: "claude" }),
    ]);
    const resolved = resolveBindingRecord(cfg);

    expect(resolved?.spec.agentId).toBe("claude");
  });

  it("returns null when no top-level ACP binding matches the conversation", () => {
    const cfg = createCfgWithBindings([
      createDiscordBinding({ conversationId: "different-channel" }),
    ]);
    const resolved = resolveBindingRecord(cfg, {
      conversationId: "thread-123",
      parentConversationId: "channel-parent-1",
    });

    expect(resolved).toBeNull();
  });

  it("applies agent runtime ACP defaults for bound conversations", () => {
    const cfg = createCfgWithBindings([createDiscordBinding({ agentId: "coding" })], {
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
    });
    const resolved = resolveBindingRecord(cfg);

    expect(resolved?.spec).toMatchObject({
      agentId: "coding",
      acpAgentId: "codex",
      mode: "oneshot",
      cwd: "/workspace/repo-a",
      backend: "acpx",
    });
  });
});

describe("resolveConfiguredAcpBindingSpecBySessionKey", () => {
  it("returns null for unknown session keys", () => {
    const spec = resolveConfiguredAcpBindingSpecBySessionKey({
      cfg: baseCfg,
      sessionKey: "agent:main:acp:binding:discord:default:notfound",
    });
    expect(spec).toBeNull();
  });

  it("prefers exact account ACP settings over wildcard when session keys collide", () => {
    const cfg = createCfgWithBindings([
      createDiscordBinding({ accountId: "*", acp: { backend: "wild" } }),
      createDiscordBinding({ acp: { backend: "exact" } }),
    ]);
    const spec = resolveConfiguredAcpBindingSpecBySessionKey({
      cfg,
      sessionKey: resolveBindingRecord(cfg)?.record.targetSessionKey ?? "",
    });

    expect(spec?.backend).toBe("exact");
  });
});

it("reinitializes a matching error-state session with the configured harness and runtime options", async () => {
  manager.closeSession.mockResolvedValue(undefined);
  manager.initializeSession.mockResolvedValue(undefined);
  const runtimeOptions = { model: "anthropic/claude-sonnet-4-6", thinking: "off" };
  const spec: ConfiguredAcpBindingSpec = {
    channel: "discord",
    accountId: defaultDiscordAccountId,
    conversationId: defaultDiscordConversationId,
    agentId: "coding",
    acpAgentId: "codex",
    mode: "persistent",
    cwd: "/home/bob/clawd",
    ...runtimeOptions,
  };
  const sessionKey = buildConfiguredAcpSessionKey(spec);
  manager.resolveSessionAsync.mockResolvedValue({
    kind: "ready",
    sessionKey,
    agentId: spec.agentId,
    meta: {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "existing",
      mode: spec.mode,
      runtimeOptions: { cwd: spec.cwd },
      state: "error",
      lastActivityAt: Date.now(),
    },
  });
  expect(await ensureConfiguredAcpBindingSession({ cfg: baseCfg, spec })).toEqual({
    ok: true,
    sessionKey,
  });
  expect(manager.closeSession).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sessionKey, clearMeta: false }),
  );
  expect(manager.initializeSession).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ agent: "codex", runtimeOptions }),
  );
  expect(manager.initializeSession.mock.calls[0]?.[0]).not.toHaveProperty("modelExplicit");
});
