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

// @mariozechner/pi-coding-agent uses 'strip-ansi' which is a missing transitive
// dep in the published package. Mock to prevent load-time failure via the
// context → browser → (transitive) → pi-coding-agent chain.
vi.mock("@mariozechner/pi-coding-agent", () => ({
  CURRENT_SESSION_VERSION: 1,
  SessionManager: vi.fn(),
  AuthStorage: vi.fn(),
  ModelRegistry: vi.fn(),
  codingTools: [],
  createReadTool: vi.fn(),
  createEditTool: vi.fn(),
  createWriteTool: vi.fn(),
  readTool: {},
  formatSkillsForPrompt: vi.fn(() => ""),
  loadSkillsFromDir: vi.fn(async () => []),
  estimateTokens: vi.fn(() => 0),
  generateSummary: vi.fn(async () => ""),
}));

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
import { maybePruneSandboxes } from "./prune.js";

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
  vi.unstubAllGlobals();
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

  it("aborts the AbortController signal when the timeout fires", async () => {
    // Call vi.useFakeTimers() BEFORE installing the AbortController stub so
    // that any AbortController instances created internally by the fake-timer
    // setup (e.g. for fake-fetch internals) use the real constructor and are
    // not accidentally captured as the "first instance". After the stub is
    // registered, only calls made during resolveSandboxContext's own execution
    // will be intercepted.
    vi.useFakeTimers();

    // Use vi.stubGlobal to intercept AbortController instantiation so we can
    // capture the signal that resolveSandboxContext threads into the inner work.
    let capturedSignal: AbortSignal | undefined;
    const RealAbortController = globalThis.AbortController;
    vi.stubGlobal(
      "AbortController",
      class extends RealAbortController {
        constructor() {
          super();
          // Only capture the first instance — that's the one created inside
          // resolveSandboxContext for the timeout race.
          if (!capturedSignal) {
            capturedSignal = this.signal;
          }
        }
      },
    );

    const promise = resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:worker:abort-test",
      workspaceDir: "/tmp/openclaw-abort-test",
    });

    // Register rejection handler before advancing time to avoid unhandled rejections.
    const assertion = expect(promise).rejects.toThrow(/timed out after 60s/i);

    // The signal must be captured and not yet aborted before the timeout fires.
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(60_001);
    await assertion;

    // After the timeout fires, the AbortController must have been aborted.
    // This is the mechanism that gives cooperative cancellation to
    // resolveSandboxContextInner: each `if (abortSignal?.aborted)` guard
    // at await boundaries will throw rather than start new Docker work.
    expect(capturedSignal?.aborted).toBe(true);

    // Confirm the inner work did start (prune was called) so we know the
    // abort check matters for future await boundaries.
    expect(maybePruneSandboxes).toHaveBeenCalledTimes(1);
  });
});
