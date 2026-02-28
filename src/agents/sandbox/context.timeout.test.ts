/**
 * Tests for the sandbox initialization timeout guard.
 *
 * Uses vi.useFakeTimers() inside the test body (not at module level), following
 * the pattern in src/agents/pi-embedded-runner.compaction-safety-timeout.test.ts.
 *
 * The module is imported at the top level (not dynamically inside the test)
 * so that vi.useFakeTimers() can reliably intercept the setTimeout call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

// Make maybePruneSandboxes hang forever to simulate a stuck Docker daemon.
vi.mock("./prune.js", () => ({
  maybePruneSandboxes: vi.fn(
    () => new Promise<void>(() => undefined /* intentionally never settles */),
  ),
}));

// Workspace helpers are no-ops for these tests.
vi.mock("./workspace.js", () => ({
  ensureSandboxWorkspace: vi.fn(async () => undefined),
}));

vi.mock("../skills.js", () => ({
  syncSkillsToWorkspace: vi.fn(async () => undefined),
}));

// Import at module level so the module is resolved before any test runs.
// This ensures vi.useFakeTimers() will intercept the setTimeout call that
// resolveSandboxContext makes inside its execution (not import-time).
import { resolveSandboxContext } from "./context.js";

const cfg: OpenClawConfig = {
  agents: {
    defaults: {
      sandbox: { mode: "all", scope: "session" },
    },
  },
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("resolveSandboxContext – timeout guard", () => {
  it("rejects with a descriptive error when initialization hangs beyond 60 s", async () => {
    vi.useFakeTimers();

    const promise = resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:worker:abc123",
      workspaceDir: "/tmp/openclaw-timeout-test",
    });

    // Register the rejection handler before advancing the clock to prevent
    // the rejection from being unhandled (follows compaction-safety-timeout pattern).
    const assertion = expect(promise).rejects.toThrow(/timed out after 60s/i);

    await vi.advanceTimersByTimeAsync(60_001);
    await assertion;

    // After the race settles, the timer must be cleared.
    expect(vi.getTimerCount()).toBe(0);
  });
});
