import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../../infra/runtime-worker-url.js";
import { agentProcessTestEntrypoints } from "../../process-runtime.test-support.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";

describe("createEmbeddedAttemptTranscriptLifecycle", () => {
  it("drains admitted transcript writes before cleanup continues", async () => {
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle({
      runId: "run-a",
      sessionId: "session-a",
    });
    let releaseWrite = () => {};
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const write = lifecycle.withTranscriptWrite(async () => {
      await writeGate;
    });
    const cleanup = lifecycle.beginCleanup();

    let cleanupSettled = false;
    void cleanup.then(() => {
      cleanupSettled = true;
    });
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);

    releaseWrite();
    await expect(write).resolves.toBeUndefined();
    await expect(cleanup).resolves.toBeUndefined();
    await expect(lifecycle.withTranscriptWrite(() => undefined)).rejects.toThrow(
      "attempt cleanup started before transcript write",
    );
  });

  it("drains fire-and-forget nested writes before admitting the next writer", async () => {
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle({});
    const order: string[] = [];
    await lifecycle.withTranscriptWrite(() => {
      order.push("outer");
      void lifecycle.withTranscriptWrite(async () => {
        await Promise.resolve();
        order.push("nested");
      });
    });
    await lifecycle.withTranscriptWrite(() => {
      order.push("next");
    });
    expect(order).toEqual(["outer", "nested", "next"]);
  });

  it("rejects cleanup started from inside a transcript callback", async () => {
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle({});
    await lifecycle.withTranscriptWrite(async () => {
      await expect(lifecycle.beginCleanup()).rejects.toThrow(
        "cannot start attempt cleanup inside a transcript write callback",
      );
    });
  });

  it("still admits a nested write from a callback that outlives the teardown budget", async () => {
    vi.useFakeTimers();
    try {
      const releaseOwner = vi.fn();
      const lifecycle = createEmbeddedAttemptTranscriptLifecycle({ onDrained: releaseOwner });
      let releaseWrite = () => {};
      const writeGate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      let nestedWrite: Promise<undefined> | undefined;
      const admitted = lifecycle.withTranscriptWrite(async () => {
        await writeGate; // outlives the teardown budget
        // Once dispose() returns (budget expired, callback still running), a nested
        // write from this callback must still be admitted as a descendant. The owned
        // store is only disabled once the actual drain settles, never on the budget.
        nestedWrite = lifecycle.withTranscriptWrite(() => {
          expect(releaseOwner).not.toHaveBeenCalled();
          return undefined;
        });
      });
      const disposeDone = lifecycle.dispose();
      await vi.advanceTimersByTimeAsync(30_000); // expire the teardown budget
      await disposeDone;
      expect(releaseOwner).not.toHaveBeenCalled();
      releaseWrite();
      await admitted;
      // If the store had been disabled when the budget expired, this nested write
      // would be rejected as disposed instead of admitted.
      await expect(nestedWrite).resolves.toBeUndefined();
      await lifecycle.dispose();
      expect(releaseOwner).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases its per-attempt AsyncLocalStorage after dispose (retention child)", async () => {
    const entrypoint = resolveRuntimeWorkerUrl(
      agentProcessTestEntrypoints.transcriptLifecycleRetention,
    );
    // Legacy Node stores require disable() to collect, so retain that regression coverage.
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    const contextFlag =
      !process.versions.bun && nodeMajor >= 24 ? ["--no-async-context-frame"] : [];
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--expose-gc", ...contextFlag, ...resolveRuntimeWorkerArgv(entrypoint)],
      { timeout: 20_000 },
    );
    expect(stdout).toContain("retention ok");
  }, 25_000);
});
