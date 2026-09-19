import { AsyncLocalStorage } from "node:async_hooks";
import { withTimeout } from "./app-server/timeout.js";
import { CodexCatalogLoadingError } from "./session-catalog-availability.js";
import { CatalogParamsError, MAX_TITLE_SEARCH_CATALOG_PAGES } from "./session-catalog-parsing.js";

export type CodexCatalogSourceAttempt =
  | { allowed: false; error: unknown }
  | {
      allowed: true;
      resolved: () => void;
      rejected: (error: unknown) => void;
      abandoned: () => void;
    };

const listRequest = new AsyncLocalStorage<CodexCatalogListRequest>();

export function currentCodexCatalogListRequest(): CodexCatalogListRequest | undefined {
  return listRequest.getStore();
}

/** One foreground request owns its native read budget and source-health outcome. */
export class CodexCatalogListRequest {
  private deadlineAt: number | undefined;
  private pages = 0;
  private closed = false;
  private failure: { error: unknown } | undefined;
  private readonly attempts = new Map<object, Map<string, CodexCatalogSourceAttempt>>();

  get hasPages(): boolean {
    return this.pages < MAX_TITLE_SEARCH_CATALOG_PAGES;
  }

  deadline(timeoutMs: number): number {
    this.assertActive();
    return (this.deadlineAt ??= performance.now() + timeoutMs);
  }

  constrainDeadline(absolute: number): number {
    this.assertActive();
    this.deadlineAt = Math.min(this.deadlineAt ?? absolute, absolute);
    return this.deadlineAt;
  }

  remaining(timeoutMs: number): number {
    const remaining = Math.min(timeoutMs, this.deadline(timeoutMs) - performance.now());
    if (remaining <= 0) {
      throw new CodexCatalogLoadingError();
    }
    return remaining;
  }

  assertActive(): void {
    if (this.closed) {
      throw new DOMException("Codex session catalog request is closed", "AbortError");
    }
    if (this.deadlineAt !== undefined && this.deadlineAt <= performance.now()) {
      throw new CodexCatalogLoadingError();
    }
  }

  async run<T>(run: () => Promise<T>): Promise<T> {
    this.assertActive();
    // The action initializes its configured deadline before its first await.
    const pending = listRequest.run(this, run);
    const remaining =
      this.deadlineAt === undefined ? undefined : this.deadlineAt - performance.now();
    if (remaining !== undefined && remaining <= 0) {
      // Work already started; retain its rejection handler after the caller times out.
      void pending.catch(() => {});
      throw new CodexCatalogLoadingError();
    }
    const result =
      remaining === undefined
        ? await pending
        : await withTimeout(
            pending,
            remaining,
            "Codex session catalog is still loading",
            () => new CodexCatalogLoadingError(),
          );
    this.assertActive();
    return result;
  }

  async read<T>(timeoutMs: number, read: (remainingMs: number) => Promise<T>): Promise<T> {
    const remaining = this.remaining(timeoutMs);
    if (!this.hasPages) {
      throw new CatalogParamsError("Codex catalog native page budget is exhausted");
    }
    this.pages++;
    try {
      const result = await withTimeout(
        read(remaining),
        remaining,
        "Codex session catalog is still loading",
        () => new CodexCatalogLoadingError(),
      );
      this.assertActive();
      return result;
    } catch (error) {
      if (!this.closed) {
        this.failure ??= { error };
      }
      throw error;
    }
  }

  attempt(
    owner: object,
    key: string,
    start: () => CodexCatalogSourceAttempt,
  ): CodexCatalogSourceAttempt {
    this.assertActive();
    let attempts = this.attempts.get(owner);
    const existing = attempts?.get(key);
    if (existing) {
      return existing;
    }
    const attempt = start();
    if (!attempts) {
      attempts = new Map();
      this.attempts.set(owner, attempts);
    }
    attempts.set(key, attempt);
    return attempt;
  }

  resolved(): void {
    if (this.failure) {
      this.rejected(this.failure.error);
      return;
    }
    this.settle((attempt) => attempt.resolved());
  }

  rejected(error: unknown): void {
    if (error instanceof Error && error.name === "AbortError") {
      this.close();
      return;
    }
    const reason = this.failure?.error ?? error;
    this.settle((attempt) => attempt.rejected(reason));
  }

  close(): void {
    this.settle((attempt) => attempt.abandoned());
  }

  private settle(settle: (attempt: Extract<CodexCatalogSourceAttempt, { allowed: true }>) => void) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const attempts of this.attempts.values()) {
      for (const attempt of attempts.values()) {
        if (attempt.allowed) {
          settle(attempt);
        }
      }
    }
    this.attempts.clear();
    this.failure = undefined;
  }
}

export async function withCodexCatalogListRequest<T>(
  run: (scope: CodexCatalogListRequest) => Promise<T>,
): Promise<T> {
  const current = currentCodexCatalogListRequest();
  if (current) {
    current.assertActive();
    return await run(current);
  }
  const scope = new CodexCatalogListRequest();
  try {
    const result = await scope.run(() => run(scope));
    scope.resolved();
    return result;
  } catch (error) {
    scope.rejected(error);
    throw error;
  }
}
