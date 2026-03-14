import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const {
  previewCortexContext,
  getCortexStatus,
  getCortexModeOverride,
  listCortexMemoryConflicts,
  ingestCortexMemoryFromText,
  syncCortexCodingContext,
} = vi.hoisted(() => ({
  previewCortexContext: vi.fn(),
  getCortexStatus: vi.fn(),
  getCortexModeOverride: vi.fn(),
  listCortexMemoryConflicts: vi.fn(),
  ingestCortexMemoryFromText: vi.fn(),
  syncCortexCodingContext: vi.fn(),
}));

vi.mock("../memory/cortex.js", () => ({
  previewCortexContext,
  getCortexStatus,
  listCortexMemoryConflicts,
  ingestCortexMemoryFromText,
  syncCortexCodingContext,
}));

vi.mock("../memory/cortex-mode-overrides.js", () => ({
  getCortexModeOverride,
}));

import {
  getAgentCortexMemoryCaptureStatus,
  ingestAgentCortexMemoryCandidate,
  resetAgentCortexConflictNoticeStateForTests,
  resolveAgentCortexConflictNotice,
  resolveAgentCortexConfig,
  resolveAgentCortexModeStatus,
  resolveAgentCortexPromptContext,
  resolveAgentTurnCortexContext,
  resolveCortexChannelTarget,
} from "./cortex.js";

beforeEach(() => {
  getCortexStatus.mockResolvedValue({
    available: true,
    workspaceDir: "/tmp/openclaw-workspace",
    graphPath: "/tmp/openclaw-workspace/.cortex/context.json",
    graphExists: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  resetAgentCortexConflictNoticeStateForTests();
});

describe("resolveAgentCortexConfig", () => {
  it("returns null when Cortex prompt bridge is disabled", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {},
        list: [{ id: "main" }],
      },
    };

    expect(resolveAgentCortexConfig(cfg, "main")).toBeNull();
  });

  it("merges defaults with per-agent overrides", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          cortex: {
            enabled: true,
            mode: "professional",
            maxChars: 1200,
            graphPath: ".cortex/default.json",
          },
        },
        list: [
          {
            id: "main",
            cortex: {
              mode: "technical",
              maxChars: 3000,
            },
          },
        ],
      },
    };

    expect(resolveAgentCortexConfig(cfg, "main")).toEqual({
      enabled: true,
      graphPath: ".cortex/default.json",
      mode: "technical",
      maxChars: 3000,
    });
  });

  it("clamps max chars to a bounded value", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          cortex: {
            enabled: true,
            maxChars: 999999,
          },
        },
        list: [{ id: "main" }],
      },
    };

    expect(resolveAgentCortexConfig(cfg, "main")?.maxChars).toBe(8000);
  });
});

describe("resolveAgentCortexPromptContext", () => {
  it("skips Cortex lookup in minimal prompt mode", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          cortex: {
            enabled: true,
          },
        },
        list: [{ id: "main" }],
      },
    };

    const result = await resolveAgentCortexPromptContext({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
      promptMode: "minimal",
    });

    expect(result).toEqual({});
    expect(previewCortexContext).not.toHaveBeenCalled();
  });

  it("returns exported context when enabled", async () => {
    getCortexModeOverride.mockResolvedValueOnce(null);
    previewCortexContext.mockResolvedValueOnce({
      workspaceDir: "/tmp/openclaw-workspace",
      graphPath: "/tmp/openclaw-workspace/.cortex/context.json",
      policy: "technical",
      maxChars: 1500,
      context: "## Cortex Context\n- Shipping",
    });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          cortex: {
            enabled: true,
          },
        },
        list: [{ id: "main" }],
      },
    };

    const result = await resolveAgentCortexPromptContext({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
      promptMode: "full",
    });

    expect(result).toEqual({
      context: "## Cortex Context\n- Shipping",
    });
    expect(previewCortexContext).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/openclaw-workspace",
        graphPath: undefined,
        policy: "technical",
        maxChars: 1500,
      }),
    );
  });

  it("prefers stored session/channel mode overrides", async () => {
    getCortexModeOverride.mockResolvedValueOnce({
      agentId: "main",
      scope: "session",
      targetId: "session-1",
      mode: "minimal",
      updatedAt: new Date().toISOString(),
    });
    previewCortexContext.mockResolvedValueOnce({
      workspaceDir: "/tmp/openclaw-workspace",
      graphPath: "/tmp/openclaw-workspace/.cortex/context.json",
      policy: "minimal",
      maxChars: 1500,
      context: "## Cortex Context\n- Minimal",
    });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          cortex: {
            enabled: true,
            mode: "technical",
          },
        },
        list: [{ id: "main" }],
      },
    };

    const result = await resolveAgentCortexPromptContext({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
      promptMode: "full",
      sessionId: "session-1",
      channelId: "slack",
    });

    expect(result).toEqual({
      context: "## Cortex Context\n- Minimal",
    });
    expect(getCortexModeOverride).toHaveBeenCalledWith({
      agentId: "main",
      sessionId: "session-1",
      channelId: "slack",
    });
    expect(previewCortexContext).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/openclaw-workspace",
        graphPath: undefined,
        policy: "minimal",
        maxChars: 1500,
      }),
    );
  });

  it("returns an error without throwing when Cortex preview fails", async () => {
    getCortexModeOverride.mockResolvedValueOnce(null);
    previewCortexContext.mockRejectedValueOnce(new Error("Cortex graph not found"));

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          cortex: {
            enabled: true,
          },
        },
        list: [{ id: "main" }],
      },
    };

    const result = await resolveAgentCortexPromptContext({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
      promptMode: "full",
    });

    expect(result.error).toContain("Cortex graph not found");
  });

  it("reuses resolved turn status when provided", async () => {
    getCortexModeOverride.mockResolvedValueOnce(null);
    previewCortexContext.mockResolvedValueOnce({
      workspaceDir: "/tmp/openclaw-workspace",
      graphPath: "/tmp/openclaw-workspace/.cortex/context.json",
      policy: "technical",
      maxChars: 1500,
      context: "## Cortex Context\n- Shipping",
    });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          cortex: {
            enabled: true,
          },
        },
        list: [{ id: "main" }],
      },
    };

    const resolved = await resolveAgentTurnCortexContext({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
    });
    const result = await resolveAgentCortexPromptContext({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
      promptMode: "full",
      resolved,
    });

    expect(result.context).toContain("Shipping");
    expect(getCortexStatus).toHaveBeenCalledTimes(1);
  });
});

describe("resolveAgentCortexConflictNotice", () => {
  it("returns a throttled high-severity conflict notice", async () => {
    listCortexMemoryConflicts.mockResolvedValueOnce([
      {
        id: "conf_1",
        type: "temporal_flip",
        severity: 0.91,
        summary: "Hiring status changed from active to paused",
      },
    ]);

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          cortex: {
            enabled: true,
          },
        },
        list: [{ id: "main" }],
      },
    };

    const notice = await resolveAgentCortexConflictNotice({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
      sessionId: "session-1",
      channelId: "channel-1",
      now: 1_000,
      cooldownMs: 10_000,
    });

    expect(notice?.conflictId).toBe("conf_1");
    expect(notice?.text).toContain("Cortex conflict detected");
    expect(notice?.text).toContain("/cortex resolve conf_1");

    const second = await resolveAgentCortexConflictNotice({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
      sessionId: "session-1",
      channelId: "channel-1",
      now: 5_000,
      cooldownMs: 10_000,
    });

    expect(second).toBeNull();
  });

  it("reuses resolved turn status when checking conflicts", async () => {
    listCortexMemoryConflicts.mockResolvedValueOnce([
      {
        id: "conf_1",
        type: "temporal_flip",
        severity: 0.91,
        summary: "Hiring status changed from active to paused",
      },
    ]);

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          cortex: {
            enabled: true,
          },
        },
        list: [{ id: "main" }],
      },
    };

    const resolved = await resolveAgentTurnCortexContext({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
      sessionId: "session-1",
      channelId: "channel-1",
    });
    await resolveAgentCortexConflictNotice({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
      sessionId: "session-1",
      channelId: "channel-1",
      resolved,
    });

    expect(getCortexStatus).toHaveBeenCalledTimes(1);
  });

  it("applies cooldown even when no Cortex conflicts are found", async () => {
    listCortexMemoryConflicts.mockResolvedValueOnce([]);

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          cortex: {
            enabled: true,
          },
        },
        list: [{ id: "main" }],
      },
    };

    const first = await resolveAgentCortexConflictNotice({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
      sessionId: "session-1",
      channelId: "channel-1",
      now: 1_000,
      cooldownMs: 10_000,
    });

    expect(first).toBeNull();
    expect(listCortexMemoryConflicts).toHaveBeenCalledTimes(1);

    const second = await resolveAgentCortexConflictNotice({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
      sessionId: "session-1",
      channelId: "channel-1",
      now: 5_000,
      cooldownMs: 10_000,
    });

    expect(second).toBeNull();
    expect(listCortexMemoryConflicts).toHaveBeenCalledTimes(1);
  });

  it("returns null when Cortex is disabled", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {},
        list: [{ id: "main" }],
      },
    };

    const notice = await resolveAgentCortexConflictNotice({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(notice).toBeNull();
    expect(listCortexMemoryConflicts).not.toHaveBeenCalled();
  });
});

describe("ingestAgentCortexMemoryCandidate", () => {
  it("captures high-signal user text into Cortex", async () => {
    ingestCortexMemoryFromText.mockResolvedValueOnce({
      workspaceDir: "/tmp/openclaw-workspace",
      graphPath: "/tmp/openclaw-workspace/.cortex/context.json",
      stored: true,
    });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          cortex: {
            enabled: true,
          },
        },
        list: [{ id: "main" }],
      },
    };

    const result = await ingestAgentCortexMemoryCandidate({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
      commandBody: "I prefer concise answers and I am focused on fundraising this quarter.",
      sessionId: "session-1",
      channelId: "channel-1",
    });

    expect(result.captured).toBe(true);
    expect(result.reason).toBe("high-signal memory candidate");
    expect(ingestCortexMemoryFromText).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/openclaw-workspace",
        graphPath: undefined,
        event: {
          actor: "user",
          text: "I prefer concise answers and I am focused on fundraising this quarter.",
          agentId: "main",
          sessionId: "session-1",
          channelId: "channel-1",
          provider: undefined,
        },
      }),
    );
    expect(
      getAgentCortexMemoryCaptureStatus({
        agentId: "main",
        sessionId: "session-1",
        channelId: "channel-1",
      }),
    ).toMatchObject({
      captured: true,
      reason: "high-signal memory candidate",
    });
  });

  it("auto-syncs coding context for technical captures", async () => {
    ingestCortexMemoryFromText.mockResolvedValueOnce({
      workspaceDir: "/tmp/openclaw-workspace",
      graphPath: "/tmp/openclaw-workspace/.cortex/context.json",
      stored: true,
    });
    syncCortexCodingContext.mockResolvedValueOnce({
      workspaceDir: "/tmp/openclaw-workspace",
      graphPath: "/tmp/openclaw-workspace/.cortex/context.json",
      policy: "technical",
      platforms: ["cursor"],
    });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          cortex: {
            enabled: true,
          },
        },
        list: [{ id: "main" }],
      },
    };

    const result = await ingestAgentCortexMemoryCandidate({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
      commandBody: "I am debugging a Python backend API bug in this repo.",
      sessionId: "session-1",
      channelId: "channel-1",
      provider: "cursor",
    });

    expect(result).toMatchObject({
      captured: true,
      syncedCodingContext: true,
      syncPlatforms: ["cursor"],
    });
    expect(syncCortexCodingContext).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/openclaw-workspace",
        graphPath: undefined,
        policy: "technical",
        platforms: ["cursor"],
      }),
    );
  });

  it("does not auto-sync generic technical chatter from messaging providers", async () => {
    ingestCortexMemoryFromText.mockResolvedValueOnce({
      workspaceDir: "/tmp/openclaw-workspace",
      graphPath: "/tmp/openclaw-workspace/.cortex/context.json",
      stored: true,
    });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          cortex: {
            enabled: true,
          },
        },
        list: [{ id: "main" }],
      },
    };

    const result = await ingestAgentCortexMemoryCandidate({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
      commandBody: "I am debugging a Python API bug right now.",
      sessionId: "session-1",
      channelId: "telegram:1",
      provider: "telegram",
    });

    expect(result).toMatchObject({
      captured: true,
      syncedCodingContext: false,
    });
    expect(syncCortexCodingContext).not.toHaveBeenCalled();
  });

  it("skips low-signal text", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          cortex: {
            enabled: true,
          },
        },
        list: [{ id: "main" }],
      },
    };

    const result = await ingestAgentCortexMemoryCandidate({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
      commandBody: "ok",
    });

    expect(result).toMatchObject({
      captured: false,
      reason: "low-signal short reply",
    });
    expect(ingestCortexMemoryFromText).not.toHaveBeenCalled();
  });

  it("reuses the same graph path across channels for the same agent", async () => {
    ingestCortexMemoryFromText.mockResolvedValue({
      workspaceDir: "/tmp/openclaw-workspace",
      graphPath: "/tmp/openclaw-workspace/.cortex/context.json",
      stored: true,
    });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          cortex: {
            enabled: true,
            graphPath: ".cortex/context.json",
          },
        },
        list: [{ id: "main" }],
      },
    };

    await ingestAgentCortexMemoryCandidate({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
      commandBody: "I prefer concise answers for work updates.",
      sessionId: "session-1",
      channelId: "slack:C123",
      provider: "slack",
    });
    await ingestAgentCortexMemoryCandidate({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
      commandBody: "I am focused on fundraising this quarter.",
      sessionId: "session-2",
      channelId: "telegram:456",
      provider: "telegram",
    });

    expect(ingestCortexMemoryFromText).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        graphPath: ".cortex/context.json",
      }),
    );
    expect(ingestCortexMemoryFromText).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        graphPath: ".cortex/context.json",
      }),
    );
  });
});

describe("resolveAgentCortexModeStatus", () => {
  it("reports the active source for a session override", async () => {
    getCortexModeOverride.mockResolvedValueOnce({
      agentId: "main",
      scope: "session",
      targetId: "session-1",
      mode: "minimal",
      updatedAt: new Date().toISOString(),
    });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          cortex: {
            enabled: true,
            mode: "technical",
            maxChars: 1500,
          },
        },
        list: [{ id: "main" }],
      },
    };

    await expect(
      resolveAgentCortexModeStatus({
        cfg,
        agentId: "main",
        sessionId: "session-1",
        channelId: "slack",
      }),
    ).resolves.toMatchObject({
      mode: "minimal",
      source: "session-override",
    });
  });
});

describe("resolveCortexChannelTarget", () => {
  it("prefers concrete conversation ids before provider labels", () => {
    expect(
      resolveCortexChannelTarget({
        channel: "slack",
        channelId: "slack",
        nativeChannelId: "C123",
      }),
    ).toBe("C123");
  });
});
