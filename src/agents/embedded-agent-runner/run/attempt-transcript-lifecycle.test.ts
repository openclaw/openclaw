import { AsyncLocalStorage } from "node:async_hooks";
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
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it("shares one context carrier across independent attempts", async () => {
    const entries = vi.spyOn(AsyncLocalStorage.prototype, "enterWith");
    await Promise.all(
      Array.from({ length: 48 }, async () => {
        const lifecycle = createEmbeddedAttemptTranscriptLifecycle({});
        await lifecycle.withTranscriptWrite(() => Promise.resolve());
        await lifecycle.dispose();
      }),
    );
    expect(new Set(entries.mock.contexts).size).toBe(1);
  });

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
        await first.withTranscriptWrite(() => order.push("nested first"));
        await expect(first.dispose()).rejects.toThrow("inside a transcript write callback");
      });
      await second.dispose();
      await expect(second.withTranscriptWrite(() => undefined)).rejects.toThrow("attempt disposed");
      await first.withTranscriptWrite(() => order.push("first after second disposed"));
    });
    await entered.promise;
    const queued = first.withTranscriptWrite(() => order.push("queued first"));
    release.resolve();
    await Promise.all([write, queued]);
    await first.dispose();
    expect(order).toEqual(["nested first", "first after second disposed", "queued first"]);
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
    await expect(write).resolves.toBeUndefined();
    await expect(cleanup).resolves.toBeUndefined();
    await expect(lifecycle.withTranscriptWrite(() => undefined)).rejects.toThrow(cleanupError);
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
    await lifecycle.withTranscriptWrite(() => order.push("next"));
    expect(order).toEqual(["outer", "nested", "next"]);
  });

  it("rejects cleanup started from inside a transcript callback", async () => {
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle({});
    await expect(lifecycle.withTranscriptWrite(() => lifecycle.beginCleanup())).rejects.toThrow(
      "cannot start attempt cleanup inside a transcript write callback",
    );
  });

  it("still admits a nested write from a callback that outlives the teardown budget", async () => {
    vi.useFakeTimers();
    const releaseOwner = vi.fn();
    const callbacksReleased = createDeferredCore();
    const releaseCallbacks = vi.fn(() => callbacksReleased.resolve());
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle({ onDrained: releaseOwner });
    const writeGate = createDeferredCore();
    let nestedWrite: Promise<undefined> | undefined;
    const admitted = lifecycle.withTranscriptWrite(async () => {
      await writeGate.promise; // Outlives the teardown budget; descendants remain admitted.
      nestedWrite = lifecycle.withTranscriptWrite(() => {
        expect(releaseOwner).not.toHaveBeenCalled();
        expect(releaseCallbacks).not.toHaveBeenCalled();
        return undefined;
      });
    });
    const cleanupDone = lifecycle.beginCleanup(releaseCallbacks);
    const disposeDone = lifecycle.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    await cleanupDone;
    await disposeDone;
    expect(releaseOwner).not.toHaveBeenCalled();
    expect(releaseCallbacks).not.toHaveBeenCalled();
    writeGate.resolve();
    await admitted;
    await expect(nestedWrite).resolves.toBeUndefined();
    await lifecycle.dispose();
    await callbacksReleased.promise;
    expect(releaseOwner).toHaveBeenCalledOnce();
    expect(releaseCallbacks).toHaveBeenCalledOnce();
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
