import { beforeEach, describe, expect, it, vi } from "vitest";
import { discordPlugin } from "../../extensions/discord/src/channel.js";
import { feishuPlugin } from "../../extensions/feishu/src/channel.js";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
const managerMocks = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  closeSession: vi.fn(),
  initializeSession: vi.fn(),
  updateSessionRuntimeOptions: vi.fn(),
}));
const sessionMetaMocks = vi.hoisted(() => ({
  readAcpSessionEntry: vi.fn(),
}));

vi.mock("./control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: managerMocks.resolveSession,
    closeSession: managerMocks.closeSession,
    initializeSession: managerMocks.initializeSession,
    updateSessionRuntimeOptions: managerMocks.updateSessionRuntimeOptions,
  }),
}));
vi.mock("./runtime/session-meta.js", () => ({
  readAcpSessionEntry: sessionMetaMocks.readAcpSessionEntry,
}));

type PersistentBindingsModule = typeof import("./persistent-bindings.js");

let buildConfiguredAcpSessionKey: PersistentBindingsModule["buildConfiguredAcpSessionKey"];
let ensureConfiguredAcpBindingSession: PersistentBindingsModule["ensureConfiguredAcpBindingSession"];
let resetAcpSessionInPlace: PersistentBindingsModule["resetAcpSessionInPlace"];
let resolveConfiguredAcpBindingRecord: PersistentBindingsModule["resolveConfiguredAcpBindingRecord"];
let resolveConfiguredAcpBindingSpecBySessionKey: PersistentBindingsModule["resolveConfiguredAcpBindingSpecBySessionKey"];

type ConfiguredBinding = NonNullable<OpenClawConfig["bindings"]>[number];
type BindingRecordInput = Parameters<typeof resolveConfiguredAcpBindingRecord>[0];
type BindingSpec = Parameters<typeof ensureConfiguredAcpBindingSession>[0]["spec"];

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    list: [{ id: "codex" }, { id: "claude" }],
  },
} satisfies OpenClawConfig;

const defaultDiscordConversationId = "1478836151241412759";
const defaultDiscordAccountId = "default";

function createCfgWithBindings(
  bindings: ConfiguredBinding[],
  overrides?: Partial<OpenClawConfig>,
): OpenClawConfig {
  return {
    ...baseCfg,
    ...overrides,
    bindings,
  } as OpenClawConfig;
}

function createDiscordBinding(params: {
  agentId: string;
  conversationId: string;
  accountId?: string;
  acp?: Record<string, unknown>;
}): ConfiguredBinding {
  return {
    type: "acp",
    agentId: params.agentId,
    match: {
      channel: "discord",
      accountId: params.accountId ?? defaultDiscordAccountId,
      peer: { kind: "channel", id: params.conversationId },
    },
    ...(params.acp ? { acp: params.acp } : {}),
  } as ConfiguredBinding;
}

function createTelegramGroupBinding(params: {
  agentId: string;
  conversationId: string;
  acp?: Record<string, unknown>;
}): ConfiguredBinding {
  return {
    type: "acp",
    agentId: params.agentId,
    match: {
      channel: "telegram",
      accountId: defaultDiscordAccountId,
      peer: { kind: "group", id: params.conversationId },
    },
    ...(params.acp ? { acp: params.acp } : {}),
  } as ConfiguredBinding;
}

function createFeishuBinding(params: {
  agentId: string;
  conversationId: string;
  accountId?: string;
  acp?: Record<string, unknown>;
}): ConfiguredBinding {
  return {
    type: "acp",
    agentId: params.agentId,
    match: {
      channel: "feishu",
      accountId: params.accountId ?? defaultDiscordAccountId,
      peer: {
        kind: params.conversationId.includes(":topic:") ? "group" : "direct",
        id: params.conversationId,
      },
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

function resolveDiscordBindingSpecBySession(
  cfg: OpenClawConfig,
  conversationId = defaultDiscordConversationId,
) {
  const resolved = resolveBindingRecord(cfg, { conversationId });
  return resolveConfiguredAcpBindingSpecBySessionKey({
    cfg,
    sessionKey: resolved?.record.targetSessionKey ?? "",
  });
}

function createDiscordPersistentSpec(overrides: Partial<BindingSpec> = {}): BindingSpec {
  return {
    channel: "discord",
    accountId: defaultDiscordAccountId,
    conversationId: defaultDiscordConversationId,
    agentId: "codex",
    mode: "persistent",
    ...overrides,
  } as BindingSpec;
}

function mockReadySession(params: { spec: BindingSpec; cwd: string }) {
  const sessionKey = buildConfiguredAcpSessionKey(params.spec);
  managerMocks.resolveSession.mockReturnValue({
    kind: "ready",
    sessionKey,
    meta: {
      backend: "acpx",
      agent: params.spec.acpAgentId ?? params.spec.agentId,
      runtimeSessionName: "existing",
      mode: params.spec.mode,
      runtimeOptions: { cwd: params.cwd },
      state: "idle",
      lastActivityAt: Date.now(),
    },
  });
  return sessionKey;
}

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "discord", plugin: discordPlugin, source: "test" },
      { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
      { pluginId: "feishu", plugin: feishuPlugin, source: "test" },
    ]),
  );
  managerMocks.resolveSession.mockReset();
  managerMocks.closeSession.mockReset().mockResolvedValue({
    runtimeClosed: true,
    metaCleared: true,
  });
  managerMocks.initializeSession.mockReset().mockResolvedValue(undefined);
  managerMocks.updateSessionRuntimeOptions.mockReset().mockResolvedValue(undefined);
  sessionMetaMocks.readAcpSessionEntry.mockReset().mockReturnValue(undefined);
});

beforeEach(async () => {
  vi.resetModules();
  ({
    buildConfiguredAcpSessionKey,
    ensureConfiguredAcpBindingSession,
    resetAcpSessionInPlace,
    resolveConfiguredAcpBindingRecord,
    resolveConfiguredAcpBindingSpecBySessionKey,
  } = await import("./persistent-bindings.js"));
});

describe("resolveConfiguredAcpBindingRecord", () => {
  it("resolves discord channel ACP binding from top-level typed bindings", () => {
    const cfg = createCfgWithBindings([
      createDiscordBinding({
        agentId: "codex",
        conversationId: defaultDiscordConversationId,
        acp: { cwd: "/repo/openclaw" },
      }),
    ]);
    const resolved = resolveBindingRecord(cfg);

    expect(resolved?.spec.channel).toBe("discord");
    expect(resolved?.spec.conversationId).toBe(defaultDiscordConversationId);
    expect(resolved?.spec.agentId).toBe("codex");
    expect(resolved?.record.targetSessionKey).toContain("agent:codex:acp:binding:discord:default:");
    expect(resolved?.record.metadata?.source).toBe("config");
  });

  it("falls back to parent discord channel when conversation is a thread id", () => {
    const cfg = createCfgWithBindings([
      createDiscordBinding({
        agentId: "codex",
        conversationId: "channel-parent-1",
      }),
    ]);
    const resolved = resolveBindingRecord(cfg, {
      conversationId: "thread-123",
      parentConversationId: "channel-parent-1",
    });

    expect(resolved?.spec.conversationId).toBe("channel-parent-1");
    expect(resolved?.record.conversation.conversationId).toBe("channel-parent-1");
  });

  it("prefers direct discord thread binding over parent channel fallback", () => {
    const cfg = createCfgWithBindings([
      createDiscordBinding({
        agentId: "codex",
        conversationId: "channel-parent-1",
      }),
      createDiscordBinding({
        agentId: "claude",
        conversationId: "thread-123",
      }),
    ]);
    const resolved = resolveBindingRecord(cfg, {
      conversationId: "thread-123",
      parentConversationId: "channel-parent-1",
    });

    expect(resolved?.spec.conversationId).toBe("thread-123");
    expect(resolved?.spec.agentId).toBe("claude");
  });

  it("prefers sender-scoped Feishu bindings over topic inheritance", () => {
    const cfg = createCfgWithBindings([
      createFeishuBinding({
        agentId: "codex",
        conversationId: "oc_group_chat:topic:om_topic_root",
        accountId: "work",
      }),
      createFeishuBinding({
        agentId: "claude",
        conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
        accountId: "work",
      }),
    ]);

    const resolved = resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "feishu",
      accountId: "work",
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
      parentConversationId: "oc_group_chat",
    });

    expect(resolved?.spec.conversationId).toBe(
      "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
    );
    expect(resolved?.spec.agentId).toBe("claude");
  });

  it("prefers exact account binding over wildcard for the same discord conversation", () => {
    const cfg = createCfgWithBindings([
      createDiscordBinding({
        agentId: "codex",
        conversationId: defaultDiscordConversationId,
        accountId: "*",
      }),
      createDiscordBinding({
        agentId: "claude",
        conversationId: defaultDiscordConversationId,
      }),
    ]);
    const resolved = resolveBindingRecord(cfg);

    expect(resolved?.spec.agentId).toBe("claude");
  });

  it("returns null when no top-level ACP binding matches the conversation", () => {
    const cfg = createCfgWithBindings([
      createDiscordBinding({
        agentId: "codex",
        conversationId: "different-channel",
      }),
    ]);
    const resolved = resolveBindingRecord(cfg, {
      conversationId: "thread-123",
      parentConversationId: "channel-parent-1",
    });

    expect(resolved).toBeNull();
  });

  it("resolves telegram forum topic bindings using canonical conversation ids", () => {
    const cfg = createCfgWithBindings([
      createTelegramGroupBinding({
        agentId: "claude",
        conversationId: "-1001234567890:topic:42",
        acp: { backend: "acpx" },
      }),
    ]);

    const canonical = resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "telegram",
      accountId: "default",
      conversationId: "-1001234567890:topic:42",
    });
    const splitIds = resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "telegram",
      accountId: "default",
      conversationId: "42",
      parentConversationId: "-1001234567890",
    });

    expect(canonical?.spec.conversationId).toBe("-1001234567890:topic:42");
    expect(splitIds?.spec.conversationId).toBe("-1001234567890:topic:42");
    expect(canonical?.spec.agentId).toBe("claude");
    expect(canonical?.spec.backend).toBe("acpx");
    expect(splitIds?.record.targetSessionKey).toBe(canonical?.record.targetSessionKey);
  });

  it("skips telegram non-group topic configs", () => {
    const cfg = createCfgWithBindings([
      createTelegramGroupBinding({
        agentId: "claude",
        conversationId: "123456789:topic:42",
      }),
    ]);

    const resolved = resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "telegram",
      accountId: "default",
      conversationId: "123456789:topic:42",
    });
    expect(resolved).toBeNull();
  });

  it("resolves Feishu DM bindings using direct peer ids", () => {
    const cfg = createCfgWithBindings([
      createFeishuBinding({
        agentId: "codex",
        conversationId: "ou_user_1",
      }),
    ]);

    const resolved = resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "feishu",
      accountId: "default",
      conversationId: "ou_user_1",
    });

    expect(resolved?.spec.channel).toBe("feishu");
    expect(resolved?.spec.conversationId).toBe("ou_user_1");
    expect(resolved?.record.targetSessionKey).toContain("agent:codex:acp:binding:feishu:default:");
  });

  it("resolves Feishu DM bindings using user_id fallback peer ids", () => {
    const cfg = createCfgWithBindings([
      createFeishuBinding({
        agentId: "codex",
        conversationId: "user_123",
      }),
    ]);

    const resolved = resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "feishu",
      accountId: "default",
      conversationId: "user_123",
    });

    expect(resolved?.spec.channel).toBe("feishu");
    expect(resolved?.spec.conversationId).toBe("user_123");
    expect(resolved?.record.targetSessionKey).toContain("agent:codex:acp:binding:feishu:default:");
  });

  it("resolves Feishu topic bindings with parent chat ids", () => {
    const cfg = createCfgWithBindings([
      createFeishuBinding({
        agentId: "claude",
        conversationId: "oc_group_chat:topic:om_topic_root",
        acp: { backend: "acpx" },
      }),
    ]);

    const resolved = resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat:topic:om_topic_root",
      parentConversationId: "oc_group_chat",
    });

    expect(resolved?.spec.conversationId).toBe("oc_group_chat:topic:om_topic_root");
    expect(resolved?.spec.agentId).toBe("claude");
    expect(resolved?.record.conversation.parentConversationId).toBe("oc_group_chat");
  });

  it("inherits configured Feishu topic bindings for sender-scoped topic conversations", () => {
    const cfg = createCfgWithBindings([
      createFeishuBinding({
        agentId: "claude",
        conversationId: "oc_group_chat:topic:om_topic_root",
        acp: { backend: "acpx" },
      }),
    ]);

    const resolved = resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      parentConversationId: "oc_group_chat",
    });

    expect(resolved?.spec.conversationId).toBe("oc_group_chat:topic:om_topic_root");
    expect(resolved?.spec.agentId).toBe("claude");
    expect(resolved?.spec.backend).toBe("acpx");
    expect(resolved?.record.conversation.conversationId).toBe("oc_group_chat:topic:om_topic_root");
  });

  it("rejects non-matching Feishu topic roots", () => {
    const cfg = createCfgWithBindings([
      createFeishuBinding({
        agentId: "claude",
        conversationId: "oc_group_chat:topic:om_topic_root",
      }),
    ]);

    const resolved = resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat:topic:om_other_root",
      parentConversationId: "oc_group_chat",
    });

    expect(resolved).toBeNull();
  });

  it("rejects Feishu non-topic group ACP bindings", () => {
    const cfg = createCfgWithBindings([
      createFeishuBinding({
        agentId: "claude",
        conversationId: "oc_group_chat",
      }),
    ]);

    const resolved = resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat",
    });

    expect(resolved).toBeNull();
  });

  it("applies agent runtime ACP defaults for bound conversations", () => {
    const cfg = createCfgWithBindings(
      [
        createDiscordBinding({
          agentId: "coding",
          conversationId: defaultDiscordConversationId,
        }),
      ],
      {
        agents: {
          list: [
            { id: "main" },
            {
              id: "coding",
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
          ],
        },
      },
    );
    const resolved = resolveBindingRecord(cfg);

    expect(resolved?.spec.agentId).toBe("coding");
    expect(resolved?.spec.acpAgentId).toBe("codex");
    expect(resolved?.spec.mode).toBe("oneshot");
    expect(resolved?.spec.cwd).toBe("/workspace/repo-a");
    expect(resolved?.spec.backend).toBe("acpx");
  });
});

describe("resolveConfiguredAcpBindingSpecBySessionKey", () => {
  it("maps a configured discord binding session key back to its spec", () => {
    const cfg = createCfgWithBindings([
      createDiscordBinding({
        agentId: "codex",
        conversationId: defaultDiscordConversationId,
        acp: { backend: "acpx" },
      }),
    ]);
    const spec = resolveDiscordBindingSpecBySession(cfg);

    expect(spec?.channel).toBe("discord");
    expect(spec?.conversationId).toBe(defaultDiscordConversationId);
    expect(spec?.agentId).toBe("codex");
    expect(spec?.backend).toBe("acpx");
  });

  it("returns null for unknown session keys", () => {
    const spec = resolveConfiguredAcpBindingSpecBySessionKey({
      cfg: baseCfg,
      sessionKey: "agent:main:acp:binding:discord:default:notfound",
    });
    expect(spec).toBeNull();
  });

  it("prefers exact account ACP settings over wildcard when session keys collide", () => {
    const cfg = createCfgWithBindings([
      createDiscordBinding({
        agentId: "codex",
        conversationId: defaultDiscordConversationId,
        accountId: "*",
        acp: { backend: "wild" },
      }),
      createDiscordBinding({
        agentId: "codex",
        conversationId: defaultDiscordConversationId,
        acp: { backend: "exact" },
      }),
    ]);
    const spec = resolveDiscordBindingSpecBySession(cfg);

    expect(spec?.backend).toBe("exact");
  });

  it("maps a configured Feishu user_id DM binding session key back to its spec", () => {
    const cfg = createCfgWithBindings([
      createFeishuBinding({
        agentId: "codex",
        conversationId: "user_123",
        acp: { backend: "acpx" },
      }),
    ]);
    const resolved = resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "feishu",
      accountId: "default",
      conversationId: "user_123",
    });
    const spec = resolveConfiguredAcpBindingSpecBySessionKey({
      cfg,
      sessionKey: resolved?.record.targetSessionKey ?? "",
    });

    expect(spec?.channel).toBe("feishu");
    expect(spec?.conversationId).toBe("user_123");
    expect(spec?.agentId).toBe("codex");
    expect(spec?.backend).toBe("acpx");
  });
});

describe("buildConfiguredAcpSessionKey", () => {
  it("is deterministic for the same conversation binding", () => {
    const sessionKeyA = buildConfiguredAcpSessionKey({
      channel: "discord",
      accountId: "default",
      conversationId: "1478836151241412759",
      agentId: "codex",
      mode: "persistent",
    });
    const sessionKeyB = buildConfiguredAcpSessionKey({
      channel: "discord",
      accountId: "default",
      conversationId: "1478836151241412759",
      agentId: "codex",
      mode: "persistent",
    });
    expect(sessionKeyA).toBe(sessionKeyB);
  });
});

describe("ensureConfiguredAcpBindingSession", () => {
  it("keeps an existing ready session when configured binding omits cwd", async () => {
    const spec = createDiscordPersistentSpec();
    const sessionKey = mockReadySession({
      spec,
      cwd: "/workspace/openclaw",
    });

    const ensured = await ensureConfiguredAcpBindingSession({
      cfg: baseCfg,
      spec,
    });

    expect(ensured).toEqual({ ok: true, sessionKey });
    expect(managerMocks.closeSession).not.toHaveBeenCalled();
    expect(managerMocks.initializeSession).not.toHaveBeenCalled();
  });

  it("reinitializes a ready session when binding config explicitly sets mismatched cwd", async () => {
    const spec = createDiscordPersistentSpec({
      cwd: "/workspace/repo-a",
    });
    const sessionKey = mockReadySession({
      spec,
      cwd: "/workspace/other-repo",
    });

    const ensured = await ensureConfiguredAcpBindingSession({
      cfg: baseCfg,
      spec,
    });

    expect(ensured).toEqual({ ok: true, sessionKey });
    expect(managerMocks.closeSession).toHaveBeenCalledTimes(1);
    expect(managerMocks.closeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        clearMeta: false,
      }),
    );
    expect(managerMocks.initializeSession).toHaveBeenCalledTimes(1);
  });

  it("initializes ACP session with runtime agent override when provided", async () => {
    const spec = createDiscordPersistentSpec({
      agentId: "coding",
      acpAgentId: "codex",
    });
    managerMocks.resolveSession.mockReturnValue({ kind: "none" });

    const ensured = await ensureConfiguredAcpBindingSession({
      cfg: baseCfg,
      spec,
    });

    expect(ensured.ok).toBe(true);
    expect(managerMocks.initializeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "codex",
      }),
    );
  });
});

describe("resetAcpSessionInPlace", () => {
  it("reinitializes from configured binding when ACP metadata is missing", async () => {
    const cfg = createCfgWithBindings([
      createDiscordBinding({
        agentId: "claude",
        conversationId: "1478844424791396446",
        acp: {
          mode: "persistent",
          backend: "acpx",
        },
      }),
    ]);
    const sessionKey = buildConfiguredAcpSessionKey({
      channel: "discord",
      accountId: "default",
      conversationId: "1478844424791396446",
      agentId: "claude",
      mode: "persistent",
      backend: "acpx",
    });
    managerMocks.resolveSession.mockReturnValue({ kind: "none" });

    const result = await resetAcpSessionInPlace({
      cfg,
      sessionKey,
      reason: "new",
    });

    expect(result).toEqual({ ok: true });
    expect(managerMocks.initializeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        agent: "claude",
        mode: "persistent",
        backendId: "acpx",
      }),
    );
  });

  it("does not clear ACP metadata before reinitialize succeeds", async () => {
    const sessionKey = "agent:claude:acp:binding:discord:default:9373ab192b2317f4";
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "claude",
        mode: "persistent",
        backend: "acpx",
        runtimeOptions: { cwd: "/home/bob/clawd" },
      },
    });
    managerMocks.initializeSession.mockRejectedValueOnce(new Error("backend unavailable"));

    const result = await resetAcpSessionInPlace({
      cfg: baseCfg,
      sessionKey,
      reason: "reset",
    });

    expect(result).toEqual({ ok: false, error: "backend unavailable" });
    expect(managerMocks.closeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        clearMeta: false,
      }),
    );
  });

  it("preserves harness agent ids during in-place reset even when not in agents.list", async () => {
    const cfg = {
      ...baseCfg,
      agents: {
        list: [{ id: "main" }, { id: "coding" }],
      },
    } satisfies OpenClawConfig;
    const sessionKey = "agent:coding:acp:binding:discord:default:9373ab192b2317f4";
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "codex",
        mode: "persistent",
        backend: "acpx",
      },
    });

    const result = await resetAcpSessionInPlace({
      cfg,
      sessionKey,
      reason: "reset",
    });

    expect(result).toEqual({ ok: true });
    expect(managerMocks.initializeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        agent: "codex",
      }),
    );
  });
});
