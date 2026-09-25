import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import {
  createIsolatedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

export function registerSharedClientStartupTests(rejectAuth: (error: Error) => void) {
  it.for(["shared", "isolated"] as const)(
    "joins %s transport startup and closes a client returned after its deadline",
    async (kind, { signal }) => {
      vi.useFakeTimers();
      const harness = createClientHarness({ autoEmitExit: false });
      let finishStart!: (client: CodexAppServerClient) => void;
      const starting = new Promise<CodexAppServerClient>((resolve) => {
        finishStart = resolve;
      });
      const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(starting);
      const acquire =
        kind === "shared"
          ? getLeasedSharedCodexAppServerClient
          : createIsolatedCodexAppServerClient;
      const releaseFixture = () => {
        finishStart(harness.client);
        harness.emitExit();
      };
      signal.addEventListener("abort", releaseFixture, { once: true });
      let settled = false;
      let rejected: Promise<void> | undefined;
      try {
        signal.throwIfAborted();
        const pending = acquire({ timeoutMs: 50 });
        rejected = expect(pending).rejects.toThrow("codex app-server initialize timed out");
        void pending.catch(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(startSpy).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(50);
        expect(settled).toBe(false);
        const stdinClosed = once(harness.process.stdin, "close", { signal });
        finishStart(harness.client);
        await stdinClosed;
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.stdinDestroyed).toBe(true);
        expect(settled).toBe(false);
      } finally {
        try {
          releaseFixture();
          await rejected;
        } finally {
          signal.removeEventListener("abort", releaseFixture);
        }
      }
      expect(harness.process.exitCode).toBe(0);
    },
  );

  it.for([
    ["shared", "validation"],
    ["shared", "abort"],
    ["shared", "timeout"],
    ["isolated", "validation"],
    ["isolated", "abort"],
    ["isolated", "timeout"],
  ] as const)(
    "awaits physical exit after %s startup %s before another attempt",
    async ([kind, mode], { signal }) => {
      vi.useFakeTimers();
      const live = new Set<ReturnType<typeof createClientHarness>>();
      const startSpy = vi.spyOn(CodexAppServerClient, "start");
      const acquire =
        kind === "shared"
          ? getLeasedSharedCodexAppServerClient
          : createIsolatedCodexAppServerClient;
      const failure = new Error("fixture auth validation failed");
      rejectAuth(failure);

      for (let attempt = 0; attempt < 3; attempt++) {
        const harness = createClientHarness({ autoEmitExit: false });
        startSpy.mockImplementationOnce(async () => {
          live.add(harness);
          harness.process.once("exit", () => live.delete(harness));
          return harness.client;
        });
        let settled = false;
        const controller = new AbortController();
        const releaseCancelledFixture = () => {
          controller.abort();
          harness.emitExit();
        };
        signal.addEventListener("abort", releaseCancelledFixture, { once: true });
        let rejected: Promise<void> | undefined;
        try {
          signal.throwIfAborted();
          const pending = acquire({ timeoutMs: 50, abandonSignal: controller.signal });
          rejected = expect(pending).rejects.toThrow(
            mode === "validation"
              ? failure.message
              : `codex app-server initialize ${mode === "abort" ? "aborted" : "timed out"}`,
          );
          void pending.catch(() => {
            settled = true;
          });
          await vi.advanceTimersByTimeAsync(0);
          const stdinClosed = once(harness.process.stdin, "close", { signal });
          if (mode === "validation") {
            const initialize = JSON.parse(harness.writes[0]!);
            harness.send({
              id: initialize.id,
              result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` },
            });
          } else if (mode === "abort") {
            controller.abort();
          }
          // Catalog identity resolves through real I/O outside the fake clock.
          await Promise.all([
            stdinClosed,
            vi.advanceTimersByTimeAsync(mode === "timeout" ? 50 : 0),
          ]);
          await vi.advanceTimersByTimeAsync(0);
          expect(harness.stdinDestroyed).toBe(true);
          expect(settled).toBe(false);
        } finally {
          try {
            harness.emitExit();
            await rejected;
          } finally {
            signal.removeEventListener("abort", releaseCancelledFixture);
          }
        }
        expect(live.size).toBe(0);
      }
      expect(startSpy).toHaveBeenCalledTimes(3);
    },
  );
}
