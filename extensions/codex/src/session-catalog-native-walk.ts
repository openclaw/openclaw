import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { CodexAppServerClient } from "./app-server/client.js";
import type { CodexAppServerClientOptions } from "./app-server/shared-client.js";

export type CodexCatalogNativeWalk = {
  signal: AbortSignal;
  abort(reason: unknown): void;
  client(timeoutMs: number): Promise<CodexAppServerClient>;
};

/** Resident rows outlive these read-only processes; a walk owns native cleanup. */
export class CodexCatalogNativeWalks {
  private readonly queue = new KeyedAsyncQueue();
  private readonly pending = new Set<Promise<unknown>>();
  private generation = new AbortController();
  private closed = false;
  private cleanupFailure: Error | undefined;

  run<T>(
    options: CodexAppServerClientOptions,
    run: (walk: CodexCatalogNativeWalk) => Promise<T>,
  ): Promise<T> {
    const signal = this.generation.signal;
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (this.closed) {
        throw new Error("Codex catalog native walks are closed");
      }
      if (this.cleanupFailure) {
        throw this.cleanupFailure;
      }
      options.assertCurrent?.();
    };
    const operation = this.queue.enqueue("native-walk", async () => {
      assertCurrent();
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      const starting = new Set<Promise<CodexAppServerClient>>();
      let acquisition: Promise<CodexAppServerClient> | undefined;
      const client = (timeoutMs: number) =>
        (acquisition ??= (async () => {
          const { createIsolatedCodexAppServerClient } =
            await import("./app-server/shared-client.js");
          assertCurrent();
          return await createIsolatedCodexAppServerClient({
            ...options,
            timeoutMs,
            abandonSignal: controller.signal,
            assertCurrent: () => {
              controller.signal.throwIfAborted();
              assertCurrent();
            },
            onStartingClient: (candidate) => starting.add(candidate),
          });
        })());
      let outcome: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        outcome = {
          ok: true,
          value: await run({
            signal: controller.signal,
            abort: (reason) => controller.abort(reason),
            client,
          }),
        };
      } catch (error) {
        outcome = { ok: false, error };
      }
      controller.abort(new Error("Codex catalog native walk finished"));
      signal.removeEventListener("abort", abort);
      // An acquisition can reject before its registration settles. Join that
      // exact candidate too, before admitting another home's native process.
      const clients = new Set<CodexAppServerClient>();
      if (acquisition) {
        await acquisition.then(
          (value) => clients.add(value),
          () => {},
        );
      }
      for (const candidate of starting) {
        await candidate.then(
          (value) => clients.add(value),
          (cause: unknown) => {
            // Rejected registration does not expose its transport's close
            // result. It cannot authorize another native startup.
            this.cleanupFailure ??= new Error(
              "Codex catalog native registration cleanup is uncertain",
              { cause },
            );
          },
        );
      }
      for (const owned of clients) {
        try {
          const result = await owned.closeAndWait({ terminateOwnedProcess: true });
          if (!result.exited || result.cleanup !== "closed") {
            throw new Error("Codex catalog native walk cleanup could not confirm process closure");
          }
        } catch (cause) {
          this.cleanupFailure ??= new Error("Codex catalog native walk cleanup is uncertain", {
            cause,
          });
        }
      }
      // Reject queued work without spawning on unknown cleanup. Retirement
      // reports that same failure instead of claiming native custody ended.
      if (this.cleanupFailure) {
        throw this.cleanupFailure;
      }
      if (!outcome.ok) {
        throw outcome.error;
      }
      return outcome.value;
    });
    this.pending.add(operation);
    const release = () => this.pending.delete(operation);
    void operation.then(release, release);
    return operation;
  }

  retire(): Promise<void> {
    this.generation.abort(new Error("Codex catalog native walk generation retired"));
    this.generation = new AbortController();
    return Promise.allSettled(this.pending).then(() => {
      if (this.cleanupFailure) {
        throw this.cleanupFailure;
      }
    });
  }

  close(): Promise<void> {
    this.closed = true;
    return this.retire();
  }
}
