import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedPiCompactResult } from "./types.js";

// Shared mock state
let harnessResultToReturn: EmbeddedPiCompactResult | null = null;
let _sideEffectsCalledWith: any = null;

const mockHarnessSession = vi.fn(async () => harnessResultToReturn);
const mockRunPostCompactionSideEffects = vi.fn(async (params: any) => {
  _sideEffectsCalledWith = params;
});

// Mock the harness selection module
vi.mock("../harness/selection.js", () => ({
  maybeCompactAgentHarnessSession: (...args: any[]) => mockHarnessSession(...args),
}));

// Mock compaction-hooks
vi.mock("./compaction-hooks.js", () => ({
  runPostCompactionSideEffects: (...args: any[]) => mockRunPostCompactionSideEffects(...args),
  asCompactionHookRunner: vi.fn(() => ({
    runCompactionHooks: vi.fn(),
  })),
}));

// Mock dependencies that are hard to set up in unit tests
vi.mock("../../context-engine/init.js", () => ({
  ensureContextEnginesInitialized: vi.fn(),
}));

vi.mock("../../context-engine/registry.js", () => ({
  resolveContextEngine: vi.fn(() => ({
    indexForQueries: vi.fn(),
    info: { ownsCompaction: false },
  })),
}));

vi.mock("../runtime-plugins.js", () => ({
  ensureRuntimePluginsLoaded: vi.fn(),
}));

vi.mock("../agent-paths.js", () => ({
  resolveOpenClawAgentDir: vi.fn(() => "/tmp/agent-dir"),
}));

vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentIds: vi.fn(() => ({ agentId: "test-agent", agentIds: [] })),
}));

vi.mock("../context-window-guard.js", () => ({
  resolveContextWindowInfo: vi.fn(() => ({ currentTokens: 1000, limitTokens: 100000 })),
}));

vi.mock("../defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 4096,
  DEFAULT_MODEL: "claude-3-5-sonnet-20241022",
  DEFAULT_PROVIDER: "anthropic",
}));

vi.mock("./compaction-runtime-context.js", () => ({
  buildEmbeddedCompactionRuntimeContext: vi.fn(() => ({})),
  resolveEmbeddedCompactionTarget: vi.fn(() => ({
    targetTokens: 500,
    targetMessages: 20,
  })),
}));

vi.mock("./context-engine-maintenance.js", () => ({
  runContextEngineMaintenance: vi.fn(),
}));

vi.mock("./lanes.js", () => ({
  resolveSessionLane: vi.fn(() => "test-lane"),
  resolveGlobalLane: vi.fn(() => "global-lane"),
}));

vi.mock("./logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("./model.js", () => ({
  resolveModelAsync: vi.fn(() => ({
    model: "claude-3-5-sonnet-20241022",
    provider: "anthropic",
  })),
}));

vi.mock("./model-context-tokens.js", () => ({
  readPiModelContextTokens: vi.fn(() => 1000),
}));

vi.mock("./compact.ts", () => ({
  persistSessionCompactionCheckpoint: vi.fn(),
  captureCompactionCheckpointSnapshot: vi.fn(),
  cleanupCompactionCheckpointSnapshot: vi.fn(),
  resolveSessionCompactionCheckpointReason: vi.fn(() => "manual"),
}));

vi.mock("../../gateway/session-compaction-checkpoints.js", () => ({
  persistSessionCompactionCheckpoint: vi.fn(),
  captureCompactionCheckpointSnapshot: vi.fn(),
  cleanupCompactionCheckpointSnapshot: vi.fn(),
  resolveSessionCompactionCheckpointReason: vi.fn(() => "manual"),
}));

vi.mock("../../process/command-queue.js", () => ({
  enqueueCommandInLane: vi.fn((_lane, fn) => fn()),
}));

vi.mock("../../utils.js", () => ({
  resolveUserPath: vi.fn((p: string) => p),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

describe("compactEmbeddedPiSession harness memory flush regression (#69300)", () => {
  beforeEach(() => {
    vi.resetModules();
    harnessResultToReturn = null;
    _sideEffectsCalledWith = null;
    mockHarnessSession.mockClear();
    mockRunPostCompactionSideEffects.mockClear();
  });

  it("calls runPostCompactionSideEffects when harness compaction succeeds", async () => {
    harnessResultToReturn = {
      ok: true,
      compacted: true,
      reason: "agent-harness",
    };

    const { compactEmbeddedPiSession } = await import("./compact.queued.js");

    await compactEmbeddedPiSession({
      sessionId: "session-69300",
      sessionKey: "agent:main:session-69300",
      config: {
        agents: {
          defaults: {
            compaction: { postIndexSync: true },
          },
        },
      } as any,
      sessionFile: "/tmp/session-69300.jsonl",
    });

    expect(mockHarnessSession).toHaveBeenCalled();
    expect(mockRunPostCompactionSideEffects).toHaveBeenCalledWith({
      config: expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({
            compaction: expect.objectContaining({ postIndexSync: true }),
          }),
        }),
      }),
      sessionKey: "agent:main:session-69300",
      sessionFile: "/tmp/session-69300.jsonl",
    });
  });

  it("does NOT call runPostCompactionSideEffects when harness returns {ok:true, compacted:false}", async () => {
    harnessResultToReturn = {
      ok: true,
      compacted: false,
      reason: "agent-harness",
    };

    const { compactEmbeddedPiSession } = await import("./compact.queued.js");

    await compactEmbeddedPiSession({
      sessionId: "session-69300",
      sessionKey: "agent:main:session-69300",
      config: {} as any,
      sessionFile: "/tmp/session-69300.jsonl",
    });

    expect(mockHarnessSession).toHaveBeenCalled();
    expect(mockRunPostCompactionSideEffects).not.toHaveBeenCalled();
  });
});
