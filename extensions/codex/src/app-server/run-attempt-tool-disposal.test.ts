import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexAttemptToolDisposer } from "./run-attempt-tool-disposal.js";

function fixture(fail?: "dynamic" | "scoped" | "configured") {
  const cleanup = (name: string) =>
    vi.fn(async () => {
      if (name === fail) {
        throw new Error(`${name} disposal failed`);
      }
    });
  const dynamic = cleanup("dynamic");
  const scoped = cleanup("scoped");
  const configured = cleanup("configured");
  const runCleanups = [dynamic];
  return {
    dynamic,
    scoped,
    configured,
    runCleanups,
    dispose: createCodexAttemptToolDisposer({
      runId: "run",
      sessionId: "session",
      runCleanups,
      disposeScopedMcp: scoped,
      disposeConfiguredMcp: configured,
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("owned native tool disposal", () => {
  it("joins one operation across required cleanup and the ordinary outer finally", async () => {
    const f = fixture();
    await Promise.all([f.dispose("completion", "required"), f.dispose("error")]);
    await expect(f.dispose("error", "required")).resolves.toBeUndefined();
    for (const cleanup of [f.dynamic, f.scoped, f.configured]) {
      expect(cleanup).toHaveBeenCalledOnce();
    }
    expect(f.dynamic).toHaveBeenCalledWith("completion");
    expect(f.runCleanups).toHaveLength(0);
  });

  it.each(["dynamic", "scoped", "configured"] as const)(
    "retains %s failure while releasing the other owners",
    async (fail) => {
      const f = fixture(fail);
      await expect(f.dispose("error", "required")).rejects.toThrow(
        "Required Codex tool cleanup failed",
      );
      await expect(f.dispose("error")).resolves.toBeUndefined();
      await expect(f.dispose("error", "required")).rejects.toThrow(
        "Required Codex tool cleanup failed",
      );
      for (const cleanup of [f.dynamic, f.scoped, f.configured]) {
        expect(cleanup).toHaveBeenCalledOnce();
      }
    },
  );

  it("never upgrades a completed best-effort operation into required settlement", async () => {
    const f = fixture();
    await f.dispose("completion");
    await expect(f.dispose("error", "required")).rejects.toThrow(
      "did not record required settlement",
    );
    expect(f.dynamic).toHaveBeenCalledOnce();
  });

  it("retains uncertainty after a required timeout and late completion", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS", "15");
    const release = createDeferred<void>();
    const dynamic = vi.fn(() => release.promise);
    const scoped = vi.fn(async () => undefined);
    const configured = vi.fn(async () => undefined);
    const dispose = createCodexAttemptToolDisposer({
      runId: "run",
      sessionId: "session",
      runCleanups: [dynamic],
      disposeScopedMcp: scoped,
      disposeConfiguredMcp: configured,
    });
    const rejected = expect(dispose("error", "required")).rejects.toThrow(
      "Required Codex tool cleanup failed",
    );
    await vi.advanceTimersByTimeAsync(15);
    await rejected;
    release.resolve();
    await expect(dispose("error")).resolves.toBeUndefined();
    await expect(dispose("error", "required")).rejects.toThrow(
      "Required Codex tool cleanup failed",
    );
    for (const cleanup of [dynamic, scoped, configured]) {
      expect(cleanup).toHaveBeenCalledOnce();
    }
  });

  it("preserves ordinary best-effort cleanup behavior after a failed tool disposer", async () => {
    const f = fixture("dynamic");
    await expect(f.dispose("error")).resolves.toBeUndefined();
    for (const cleanup of [f.dynamic, f.scoped, f.configured]) {
      expect(cleanup).toHaveBeenCalledOnce();
    }
  });
});
