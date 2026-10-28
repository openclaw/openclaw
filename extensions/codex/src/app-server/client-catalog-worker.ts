import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import { codexCatalogPageWorkerEntrypoint } from "../../catalog-page-worker-entrypoint.js";
import {
  projectCodexCatalogMessage,
  type CodexCatalogDecodeInput,
  type CodexCatalogDecodeResult,
  type CodexClientRequestAttempt,
} from "./client-catalog-response.js";
import type { CodexCatalogDecodeRoute } from "./client-catalog-route.js";
import { isJsonObject } from "./protocol.js";
import { CodexCatalogResponseTooLargeError } from "./rpc-error.js";

const INLINE_CATALOG_MAX_BYTES = 64 * 1024;
const CATALOG_MAX_BYTES = 8 * 1024 * 1024;
// Bounded headroom for irreducible previews; larger singletons retain the overflow cooldown.
const CATALOG_SINGLETON_MAX_BYTES = 64 * 1024 * 1024;
const loadProcessRuntime = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/process-runtime"),
);

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
  private closed = false;

  async decode(
    line: Buffer,
    route: CodexCatalogDecodeRoute,
    attempts: ReadonlyMap<number | string, CodexClientRequestAttempt>,
  ): Promise<CodexCatalogDecodeResult | undefined> {
    if (this.closed) {
      return undefined;
    }
    const oversizedSingleton =
      line.byteLength > CATALOG_MAX_BYTES &&
      route !== "unresolved" &&
      route.kind === "list" &&
      attempts.get(route.id)?.catalogProjection?.singleThread === true;
    if (line.byteLength > (oversizedSingleton ? CATALOG_SINGLETON_MAX_BYTES : CATALOG_MAX_BYTES)) {
      const error = new CodexCatalogResponseTooLargeError();
      return route === "unresolved"
        ? { failures: [{ byteCount: line.byteLength, fragmentCount: 1 }] }
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
        const attempt = attempts.get(route.id);
        const projection = attempt?.catalogProjection;
        return projectCodexCatalogMessage(
          parsed,
          { route, remainingRows: attempt ? projection?.remainingRows : 0 },
          projection?.preview,
        );
      }
    }
    if (!this.pool) {
      const { resolveRuntimeWorkerUrl, WorkerTaskPool } = await loadProcessRuntime();
      if (this.closed) {
        return undefined;
      }
      this.pool = new WorkerTaskPool<CodexCatalogDecodeInput, CodexCatalogDecodeResult>({
        workerUrl: resolveRuntimeWorkerUrl(codexCatalogPageWorkerEntrypoint),
        workerClass: "singleton",
        maxPendingTasks: 1,
        maxPendingBytes: CATALOG_SINGLETON_MAX_BYTES,
        restartOnError: false,
        onRetirementFailure: (error) => {
          // Refuse queued pages promptly when native retirement retains the only slot.
          void this.pool?.close(error).catch(() => undefined);
        },
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
      { bytes, route, remainingRows, oversizedSingleton },
      {
        inputBytes: bytes.byteLength,
        transferList: (input) => [input.bytes.buffer],
      },
    );
    if (this.closed) {
      return undefined;
    }
    if (oversizedSingleton && !decoded.message) {
      // Restore the local error type after worker serialization so the existing cooldown applies.
      return {
        failures: decoded.failures,
        projectionError: { id: route.id, error: new CodexCatalogResponseTooLargeError() },
      };
    }
    return decoded;
  }

  async close(error: Error): Promise<void> {
    this.closed = true;
    // Close can join an in-flight idle stop; retry its failed custody before returning.
    await this.pool?.close(error).catch(() => this.pool?.close(error));
  }
}
