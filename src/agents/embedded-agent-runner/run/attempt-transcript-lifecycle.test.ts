import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../../infra/runtime-worker-url.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { agentProcessTestEntrypoints } from "../../process-runtime.test-support.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";

describe("createEmbeddedAttemptTranscriptLifecycle", () => {
  it("shares one context carrier across independent attempts", async () => {
    const entries = vi.spyOn(AsyncLocalStorage.prototype, "run");
    try {
      await Promise.all(
        Array.from({ length: 48 }, async () => {
          const lifecycle = createEmbeddedAttemptTranscriptLifecycle({});
          await lifecycle.withTranscriptWrite(async () => await Promise.resolve());
          await lifecycle.dispose();
        }),
      );
      expect(new Set(entries.mock.contexts).size).toBe(1);
    } finally {
      entries.mockRestore();
    }
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
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle({
      runId: "run-a",
      sessionId: "session-a",
      onDrained: async () => {
        await expect(lifecycle.withTranscriptWrite(() => undefined)).rejects.toThrow(
          "attempt cleanup started before transcript write",
        );
      },
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
        // write from this callback must still be admitted as a descendant.
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
      // Retiring the owner when the budget expires would reject this descendant.
      await expect(nestedWrite).resolves.toBeUndefined();
      await lifecycle.dispose();
      expect(releaseOwner).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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
