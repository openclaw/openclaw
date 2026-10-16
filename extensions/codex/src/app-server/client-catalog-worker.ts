import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import { codexCatalogPageWorkerEntrypoint } from "../../catalog-page-worker-entrypoint.js";
import {
  projectCodexCatalogMessage,
  type CodexCatalogDecodeInput,
  type CodexCatalogDecodeResult,
  type CodexClientRequestAttempt,
} from "./client-catalog-response.js";
import type { CodexCatalogDecodeRoute } from "./client-message-frames.js";
import { isJsonObject } from "./protocol.js";

const INLINE_CATALOG_MAX_BYTES = 64 * 1024;
const CATALOG_MAX_BYTES = 8 * 1024 * 1024;
const CATALOG_WORKER_IDLE_MS = 60_000;
const runInCatalogWorkerContext = AsyncLocalStorage.snapshot();

/** Late responses retain their decode route after cancellation removes the waiter. */
export function codexCatalogRequestId(
  method: string,
  params: unknown,
  sequence: number,
  catalogPreview?: true,
): number {
  if (!catalogPreview) {
    return sequence;
  }
  const thread = method === "thread/read" && isJsonObject(params) && params.includeTurns !== true;
  // Preserve positive numeric diagnostic IDs. The upper safe-integer half is
  // reserved for catalog reads; ordinary IDs keep their existing sequence.
  return method === "thread/list" || thread
    ? Number.MAX_SAFE_INTEGER - 2 * sequence - (thread ? 1 : 0)
    : sequence;
}

/** Each physical client owns one catalog projection worker. */
export class CodexCatalogWorker {
  private pool: WorkerTaskPool<CodexCatalogDecodeInput, CodexCatalogDecodeResult> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private retirement: Promise<void> | undefined;
  private readonly setTimeoutFn = setTimeout;
  private readonly clearTimeoutFn = clearTimeout;
  private closed = false;

  async decode(
    line: Buffer,
    route: CodexCatalogDecodeRoute,
    attempts: ReadonlyMap<number | string, CodexClientRequestAttempt>,
  ): Promise<CodexCatalogDecodeResult | undefined> {
    if (this.closed) {
      return undefined;
    }
    if (line.byteLength > CATALOG_MAX_BYTES) {
      const error = new Error(
        "Codex catalog response exceeds 8 MiB; reduce oversized thread previews and retry.",
      );
      return route === "unresolved"
        ? { failures: [{ value: "<oversized catalog response>", error, fragmentCount: 1 }] }
        : { failures: [], projectionError: { id: route.id, error } };
    }
    if (route !== "unresolved" && line.byteLength <= INLINE_CATALOG_MAX_BYTES) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.toString("utf8"));
      } catch {
        // Keep malformed-payload diagnostics off the main thread.
      }
      if (parsed !== undefined) {
        // Cache callbacks observe closure and cancellation before asynchronous delivery.
        await Promise.resolve();
        if (this.closed) {
          return undefined;
        }
        const attempt = attempts.get(route.id);
        const projection = attempt?.catalogProjection;
        return projectCodexCatalogMessage(
          parsed,
          { route, remainingRows: attempt ? projection?.remainingRows : 0 },
          projection?.preview,
        );
      }
    }
    this.clearTimeoutFn(this.idleTimer);
    this.idleTimer = undefined;
    // Rotation retains the pool's custody until native exit; new frames wait here.
    await this.retirement;
    if (this.closed) {
      return undefined;
    }
    if (!this.pool) {
      const { resolveRuntimeWorkerUrl, WorkerTaskPool } =
        await import("openclaw/plugin-sdk/process-runtime");
      if (this.closed) {
        return undefined;
      }
      this.pool = new WorkerTaskPool<CodexCatalogDecodeInput, CodexCatalogDecodeResult>({
        workerUrl: resolveRuntimeWorkerUrl(codexCatalogPageWorkerEntrypoint),
        workerClass: "singleton",
        maxPendingTasks: 1,
        maxPendingBytes: CATALOG_MAX_BYTES,
        idleTimeoutMs: 0,
        restartOnError: false,
      });
    }
    const attempt = route === "unresolved" ? undefined : attempts.get(route.id);
    const remainingRows = attempt ? attempt.catalogProjection?.remainingRows : 0;
    // Transfer an exclusively owned backing store; never detach a pooled Buffer or
    // the unread suffix of a transport chunk shared with notifications.
    const bytes =
      line.byteLength === line.buffer.byteLength && line.buffer instanceof ArrayBuffer
        ? new Uint8Array(line.buffer)
        : Uint8Array.from(line);
    const decoded = await this.pool.run(
      { bytes, route, remainingRows },
      {
        inputBytes: bytes.byteLength,
        transferList: (input) => [input.bytes.buffer],
      },
    );
    if (this.closed) {
      return undefined;
    }
    this.armIdleRetirement();
    return decoded;
  }

  private armIdleRetirement(): void {
    // Do not retain the decoded page or its caller's async context in this timer.
    this.idleTimer = runInCatalogWorkerContext(() =>
      this.setTimeoutFn(() => {
        this.idleTimer = undefined;
        this.retirement = this.pool?.rotate();
        // The next decode observes failure; terminal close still owns a cleanup retry.
        void this.retirement?.catch(() => undefined);
      }, CATALOG_WORKER_IDLE_MS),
    );
    this.idleTimer.unref();
  }

  async close(error: Error): Promise<void> {
    this.closed = true;
    this.clearTimeoutFn(this.idleTimer);
    this.idleTimer = undefined;
    // A failed rotation must release its stop attempt before close retries custody.
    await this.retirement?.catch(() => undefined);
    await this.pool?.close(error);
  }
}
