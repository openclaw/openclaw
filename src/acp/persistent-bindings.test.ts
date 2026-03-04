import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
const managerMocks = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  closeSession: vi.fn(),
  initializeSession: vi.fn(),
}));

vi.mock("./control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: managerMocks.resolveSession,
    closeSession: managerMocks.closeSession,
    initializeSession: managerMocks.initializeSession,
  }),
}));

import {
  buildConfiguredAcpSessionKey,
  ensureConfiguredAcpBindingSession,
  resolveConfiguredAcpBindingRecord,
} from "./persistent-bindings.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    list: [{ id: "codex" }, { id: "claude" }],
  },
} satisfies OpenClawConfig;

beforeEach(() => {
  managerMocks.resolveSession.mockReset();
  managerMocks.closeSession.mockReset().mockResolvedValue({
    runtimeClosed: true,
    metaCleared: true,
  });
  managerMocks.initializeSession.mockReset().mockResolvedValue(undefined);
});

describe("resolveConfiguredAcpBindingRecord", () => {
  it("resolves discord channel ACP binding from top-level typed bindings", () => {
    const cfg = {
      ...baseCfg,
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: "1478836151241412759" },
          },
          acp: {
            cwd: "/repo/openclaw",
          },
        },
      ],
    } satisfies OpenClawConfig;

    const resolved = resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "discord",
      accountId: "default",
      conversationId: "1478836151241412759",
    });

    expect(resolved?.spec.channel).toBe("discord");
    expect(resolved?.spec.conversationId).toBe("1478836151241412759");
    expect(resolved?.spec.agentId).toBe("codex");
    expect(resolved?.record.targetSessionKey).toContain("agent:codex:acp:binding:discord:default:");
    expect(resolved?.record.metadata?.source).toBe("config");
  });

  it("falls back to parent discord channel when conversation is a thread id", () => {
    const cfg = {
      ...baseCfg,
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: "channel-parent-1" },
          },
        },
      ],
    } satisfies OpenClawConfig;

    const resolved = resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "discord",
      accountId: "default",
      conversationId: "thread-123",
      parentConversationId: "channel-parent-1",
    });

    expect(resolved?.spec.conversationId).toBe("channel-parent-1");
    expect(resolved?.record.conversation.conversationId).toBe("channel-parent-1");
  });

  it("returns null when no top-level ACP binding matches the conversation", () => {
    const cfg = {
      ...baseCfg,
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: "different-channel" },
          },
        },
      ],
    } satisfies OpenClawConfig;

    const resolved = resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "discord",
      accountId: "default",
      conversationId: "thread-123",
      parentConversationId: "channel-parent-1",
    });

    expect(resolved).toBeNull();
  });

  it("resolves telegram forum topic bindings using canonical conversation ids", () => {
    const cfg = {
      ...baseCfg,
      bindings: [
        {
          type: "acp",
          agentId: "claude",
          match: {
            channel: "telegram",
            accountId: "default",
            peer: { kind: "group", id: "-1001234567890:topic:42" },
          },
          acp: {
            backend: "acpx",
          },
        },
      ],
    } satisfies OpenClawConfig;

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
    const cfg = {
      ...baseCfg,
      bindings: [
        {
          type: "acp",
          agentId: "claude",
          match: {
            channel: "telegram",
            accountId: "default",
            peer: { kind: "group", id: "123456789:topic:42" },
          },
        },
      ],
    } satisfies OpenClawConfig;

    const resolved = resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "telegram",
      accountId: "default",
      conversationId: "123456789:topic:42",
    });
    expect(resolved).toBeNull();
  });

  it("applies agent runtime ACP defaults for bound conversations", () => {
    const cfg = {
      ...baseCfg,
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
      bindings: [
        {
          type: "acp",
          agentId: "coding",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: "1478836151241412759" },
          },
        },
      ],
    } satisfies OpenClawConfig;

    const resolved = resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "discord",
      accountId: "default",
      conversationId: "1478836151241412759",
    });

    expect(resolved?.spec.agentId).toBe("coding");
    expect(resolved?.spec.acpAgentId).toBe("codex");
    expect(resolved?.spec.mode).toBe("oneshot");
    expect(resolved?.spec.cwd).toBe("/workspace/repo-a");
    expect(resolved?.spec.backend).toBe("acpx");
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
    const spec = {
      channel: "discord" as const,
      accountId: "default",
      conversationId: "1478836151241412759",
      agentId: "codex",
      mode: "persistent" as const,
    };
    const sessionKey = buildConfiguredAcpSessionKey(spec);
    managerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey,
      meta: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "existing",
        mode: "persistent",
        runtimeOptions: { cwd: "/workspace/openclaw" },
        state: "idle",
        lastActivityAt: Date.now(),
      },
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
    const spec = {
      channel: "discord" as const,
      accountId: "default",
      conversationId: "1478836151241412759",
      agentId: "codex",
      mode: "persistent" as const,
      cwd: "/workspace/repo-a",
    };
    const sessionKey = buildConfiguredAcpSessionKey(spec);
    managerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey,
      meta: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "existing",
        mode: "persistent",
        runtimeOptions: { cwd: "/workspace/other-repo" },
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });

    const ensured = await ensureConfiguredAcpBindingSession({
      cfg: baseCfg,
      spec,
    });

    expect(ensured).toEqual({ ok: true, sessionKey });
    expect(managerMocks.closeSession).toHaveBeenCalledTimes(1);
    expect(managerMocks.initializeSession).toHaveBeenCalledTimes(1);
  });

  it("initializes ACP session with runtime agent override when provided", async () => {
    const spec = {
      channel: "discord" as const,
      accountId: "default",
      conversationId: "1478836151241412759",
      agentId: "coding",
      acpAgentId: "codex",
      mode: "persistent" as const,
    };
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
