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

// Make maybePruneSandboxes controllable per-test (default: hang forever).
let pruneResolve: (() => void) | undefined;
vi.mock("./prune.js", () => ({
  maybePruneSandboxes: vi.fn(
    () =>
      new Promise<void>((resolve) => {
        pruneResolve = resolve;
      }),
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
  pruneResolve = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveSandboxContext – timeout guard", () => {
  it("rejects with a descriptive error when initialization hangs beyond the configured timeout", async () => {
    vi.useFakeTimers();

    const promise = resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:worker:abc123",
      workspaceDir: "/tmp/openclaw-timeout-test",
    });

    // Register the rejection handler before advancing the clock to prevent
    // the rejection from being unhandled (follows compaction-safety-timeout pattern).
    // Default Docker backend timeout is 60s.
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

  it("aborts the init signal even on the success path so detached inner work stops", async () => {
    // This tests that resolveSandboxContext's .finally() aborts the controller
    // when init completes normally. If it did not, any detached raceAbort
    // listeners or pending Docker child processes from the "losing" side of
    // Promise.race would linger until process exit.
    //
    // We let maybePruneSandboxes succeed, but the next step
    // (ensureSandboxWorkspaceLayout -> resolveUserPath) will throw because
    // there is no real workspace. That error propagates through the race and
    // triggers the .finally() abort on the non-timeout path.
    vi.useFakeTimers();

    let capturedSignal: AbortSignal | undefined;
    const RealAbortController = globalThis.AbortController;
    vi.stubGlobal(
      "AbortController",
      class extends RealAbortController {
        constructor() {
          super();
          if (!capturedSignal) {
            capturedSignal = this.signal;
          }
        }
      },
    );

    // Let prune resolve immediately so the inner work continues past raceAbort.
    const promise = resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:worker:success-abort-test",
      workspaceDir: "/tmp/openclaw-success-abort-test",
    });

    // Resolve the hung prune so the inner work advances past raceAbort.
    pruneResolve?.();

    // The inner work will fail at a later step (no real backend/workspace),
    // but the .finally() should still abort the controller.
    try {
      await promise;
    } catch {
      // Expected — the init flow will fail without real Docker/workspace.
    }

    expect(capturedSignal).toBeDefined();
    // The signal must be aborted even though no timeout fired — the .finally()
    // handler aborts the controller to clean up detached inner work.
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("uses a longer timeout for SSH (remote) backends", async () => {
    vi.useFakeTimers();

    const sshCfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "session", backend: "ssh" },
        },
      },
    };

    const promise = resolveSandboxContext({
      config: sshCfg,
      sessionKey: "agent:worker:ssh-timeout-test",
      workspaceDir: "/tmp/openclaw-ssh-timeout-test",
    });

    // At 60s the Docker default would fire, but SSH uses 300s.
    // Register rejection handler early.
    const assertion = expect(promise).rejects.toThrow(/timed out after 300s/i);

    // Advance past the Docker default — should NOT have timed out yet.
    await vi.advanceTimersByTimeAsync(60_001);
    // Timer should still be active (SSH backend has 300s default).
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // Advance to 300s+ to trigger the actual timeout.
    await vi.advanceTimersByTimeAsync(240_000);
    await assertion;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("respects a custom initTimeoutMs from config", async () => {
    vi.useFakeTimers();

    const customCfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "session", initTimeoutMs: 10_000 },
        },
      },
    };

    const promise = resolveSandboxContext({
      config: customCfg,
      sessionKey: "agent:worker:custom-timeout-test",
      workspaceDir: "/tmp/openclaw-custom-timeout-test",
    });

    const assertion = expect(promise).rejects.toThrow(/timed out after 10s/i);

    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;

    expect(vi.getTimerCount()).toBe(0);
  });
});
