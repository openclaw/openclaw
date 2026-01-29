import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock model-selection to control isCliProvider behavior
vi.mock("../model-selection.js", () => ({
  isCliProvider: vi.fn((provider: string) => {
    return provider === "claude-cli" || provider === "codex-cli";
  }),
}));

// Mock defaults
vi.mock("../defaults.js", () => ({
  DEFAULT_PROVIDER: "anthropic",
  DEFAULT_MODEL: "claude-sonnet-4",
}));

// Mock models-config - ensure async function returns
vi.mock("../models-config.js", () => ({
  ensureMoltbotModelsJson: vi.fn(async () => {}),
}));

// Mock agent-paths
vi.mock("../agent-paths.js", () => ({
  resolveMoltbotAgentDir: vi.fn(() => "/tmp/test-agent"),
}));

// Mock utils
vi.mock("../../utils.js", () => ({
  resolveUserPath: vi.fn((p: string) => p),
}));

// Import after mocks are set up
import { compactEmbeddedPiSessionDirect } from "./compact.js";

describe("compactEmbeddedPiSessionDirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error for CLI provider claude-cli", async () => {
    const result = await compactEmbeddedPiSessionDirect({
      sessionId: "test-session",
      sessionFile: "/tmp/test.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "claude-cli",
      model: "opus",
    });

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("Compaction is not supported for CLI providers");
    expect(result.reason).toContain("claude-cli");
    expect(result.reason).toContain("Use /model to switch to an API provider");
  });

  it("returns error for CLI provider codex-cli", async () => {
    const result = await compactEmbeddedPiSessionDirect({
      sessionId: "test-session",
      sessionFile: "/tmp/test.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "codex-cli",
      model: "default",
    });

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("Compaction is not supported for CLI providers");
    expect(result.reason).toContain("codex-cli");
  });
});
