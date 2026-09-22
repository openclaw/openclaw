import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTimeout } from "./app-server/timeout.js";
import {
  compareCodexCatalogRows,
  type CodexCatalogOrderKey,
} from "./session-catalog-index-order.js";

export class CodexCatalogLoadingError extends Error {
  readonly code = "APP_SERVER_UNAVAILABLE";

  constructor() {
    super("Codex session catalog is still loading. Retry shortly.");
  }
}

/** One generation promise wakes cold callers; native pages remain owned by the index. */
export class CodexCatalogAvailability {
  complete = false;
  frontier: CodexCatalogOrderKey | undefined;
  private changed = createDeferred<void>();
  private failure: { error: unknown } | undefined;

  begin(): void {
    this.failure = undefined;
  }

  publish(frontier: CodexCatalogOrderKey | undefined, complete = false): void {
    if (this.complete) {
      return;
    }
    if (frontier && (!this.frontier || compareCodexCatalogRows(frontier, this.frontier) > 0)) {
      const { threadId, updatedAt, recencyAt, sourceOrder } = frontier;
      this.frontier = { threadId, updatedAt, recencyAt, sourceOrder };
    }
    this.complete = complete;
    this.notify();
  }

  fail(error: unknown): void {
    this.failure = { error };
    this.notify();
  }

  private notify(): void {
    const previous = this.changed;
    this.changed = createDeferred<void>();
    previous.resolve();
  }

  async until<T>(promise: Promise<T>, deadline: number): Promise<T> {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new CodexCatalogLoadingError();
    }
    return await withTimeout(
      promise,
      remaining,
      "Codex session catalog is still loading",
      () => new CodexCatalogLoadingError(),
    );
  }

  async next(deadline: number): Promise<void> {
    if (this.failure) {
      throw this.failure.error;
    }
    await this.until(this.changed.promise, deadline);
  }
}
