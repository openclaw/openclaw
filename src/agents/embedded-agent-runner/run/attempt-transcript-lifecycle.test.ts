import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../../infra/runtime-worker-url.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { agentProcessTestEntrypoints } from "../../process-runtime.test-support.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";

describe("createEmbeddedAttemptTranscriptLifecycle", () => {
  afterEach(() => vi.useRealTimers());
  it("preserves reentrant writes across attempts and isolates their cleanup", async () => {
    const first = createEmbeddedAttemptTranscriptLifecycle({});
    const second = createEmbeddedAttemptTranscriptLifecycle({});
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const order: string[] = [];
    const write = first.withTranscriptWrite(async () => {
      entered.resolve();
      await release.promise;
      await second.withTranscriptWrite(async () => {
        await first.withTranscriptWrite(() => order.push("nested"));
        await expect(first.dispose()).rejects.toThrow("inside a transcript write callback");
        await expect(first.beginCleanup()).rejects.toThrow(
          "cannot start attempt cleanup inside a transcript write callback",
        );
      });
      await second.dispose();
      await expect(second.withTranscriptWrite(() => undefined)).rejects.toThrow("attempt disposed");
      await first.withTranscriptWrite(() => order.push("after second"));
      void first.withTranscriptWrite(async () => {
        await Promise.resolve();
        order.push("unawaited");
      });
    });
    await entered.promise;
    const queued = first.withTranscriptWrite(() => order.push("queued"));
    release.resolve();
    await Promise.all([write, queued]);
    await first.dispose();
    expect(order).toEqual(["nested", "after second", "unawaited", "queued"]);
  });

  it("drains admitted transcript writes before cleanup continues", async () => {
    const cleanupError = "attempt cleanup started before transcript write";
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle({
      onDrained: () =>
        expect(lifecycle.withTranscriptWrite(() => undefined)).rejects.toThrow(cleanupError),
    });
    const writeGate = createDeferredCore();
    const write = lifecycle.withTranscriptWrite(() => writeGate.promise);
    const cleanup = lifecycle.beginCleanup();

    const cleanupSettled = vi.fn();
    void cleanup.then(cleanupSettled);
    await Promise.resolve();
    expect(cleanupSettled).not.toHaveBeenCalled();

    writeGate.resolve();
    await Promise.all([write, cleanup]);
    await expect(lifecycle.withTranscriptWrite(() => undefined)).rejects.toThrow(cleanupError);
  });

  it("still admits a nested write from a callback that outlives the teardown budget", async () => {
    vi.useFakeTimers();
    const releaseOwner = vi.fn();
    const callbacksReleased = createDeferredCore();
    const releaseCallbacks = vi.fn(() => callbacksReleased.resolve());
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle({ onDrained: releaseOwner });
    const writeGate = createDeferredCore();
    let nestedWrite: Promise<void> | undefined;
    const admitted = lifecycle.withTranscriptWrite(async () => {
      await writeGate.promise; // Outlives the teardown budget; descendants remain admitted.
      nestedWrite = lifecycle.withTranscriptWrite(() => {
        expect([releaseOwner.mock.calls, releaseCallbacks.mock.calls]).toEqual([[], []]);
      });
    });
    const cleanupDone = lifecycle.beginCleanup(releaseCallbacks);
    const disposeDone = lifecycle.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    await cleanupDone;
    await disposeDone;
    expect([releaseOwner.mock.calls, releaseCallbacks.mock.calls]).toEqual([[], []]);
    writeGate.resolve();
    await admitted;
    await expect(nestedWrite).resolves.toBeUndefined();
    await callbacksReleased.promise;
    expect([releaseOwner.mock.calls.length, releaseCallbacks.mock.calls.length]).toEqual([1, 1]);
  });

  it("releases disposed attempts with a shared context carrier (retention child)", async () => {
    const entrypoint = resolveRuntimeWorkerUrl(
      agentProcessTestEntrypoints.transcriptLifecycleRetention,
    );
    // Exercise the legacy context implementation as well as the default in-process tests.
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
