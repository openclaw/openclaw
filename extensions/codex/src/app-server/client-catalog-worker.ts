import type { WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import { codexCatalogPageWorkerEntrypoint } from "../../catalog-page-worker-entrypoint.js";
import type { CodexCatalogPreviewCache } from "../session-catalog-native-projection.js";
import {
  projectCodexCatalogMessage,
  type CodexCatalogDecodeInput,
  type CodexCatalogDecodeResult,
} from "./client-catalog-response.js";
import type { CodexCatalogDecodeRoute } from "./client-message-frames.js";
import { isJsonObject } from "./protocol.js";
import type { CodexRequestAttempt } from "./request-attempt.js";

const INLINE_CATALOG_MAX_BYTES = 64 * 1024;

/** Late responses retain their decode route after cancellation removes the waiter. */
export function codexCatalogRequestId(
  method: string,
  params: unknown,
  sequence: number,
  catalogPreview?: true,
): number {
  const kind = catalogPreview
    ? method === "thread/list"
      ? "list"
      : method === "thread/read" && isJsonObject(params) && params.includeTurns !== true
        ? "thread"
        : undefined
    : undefined;
  // Preserve positive numeric diagnostic IDs. The upper safe-integer half is
  // reserved for catalog reads; ordinary IDs keep their existing sequence.
  return kind ? Number.MAX_SAFE_INTEGER - 2 * sequence - (kind === "thread" ? 1 : 0) : sequence;
}

/** Each physical client owns one decoder, including incomplete-line recovery state. */
export class CodexCatalogWorker {
  private pool: WorkerTaskPool<CodexCatalogDecodeInput, CodexCatalogDecodeResult> | undefined;
  private continuationRoute: CodexCatalogDecodeRoute | undefined;
  private closed = false;

  get continuation(): CodexCatalogDecodeRoute | undefined {
    return this.continuationRoute;
  }

  async decode(
    line: Buffer,
    route: CodexCatalogDecodeRoute,
    attempts: ReadonlyMap<number | string, CodexRequestAttempt>,
    projections: Pick<
      WeakMap<CodexRequestAttempt, { preview?: CodexCatalogPreviewCache; remainingRows?: number }>,
      "get"
    >,
  ) {
    if (this.closed) {
      return undefined;
    }
    if (
      !this.continuationRoute &&
      route !== "unresolved" &&
      line.byteLength <= INLINE_CATALOG_MAX_BYTES
    ) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.toString("utf8"));
      } catch {
        // Incomplete or malformed frames retain the worker's recovery state.
      }
      if (parsed !== undefined) {
        // Cache callbacks observe closure and cancellation before asynchronous delivery.
        await Promise.resolve();
        if (this.closed) {
          return undefined;
        }
        const attempt = attempts.get(route.id);
        const projection = attempt ? projections.get(attempt) : undefined;
        return projectCodexCatalogMessage(
          parsed,
          { route, remainingRows: attempt ? projection?.remainingRows : 0 },
          projection?.preview,
        );
      }
    }
    if (!this.pool) {
      const { resolveRuntimeWorkerUrl, WorkerTaskPool } =
        await import("openclaw/plugin-sdk/process-runtime");
      if (this.closed) {
        return undefined;
      }
      this.pool = new WorkerTaskPool<CodexCatalogDecodeInput, CodexCatalogDecodeResult>({
        workerUrl: resolveRuntimeWorkerUrl(codexCatalogPageWorkerEntrypoint),
        maxWorkers: 1,
        maxPendingTasks: 1,
        // Framing admits one line at a time. Completed native messages have no size cap;
        // only incomplete recovery is subject to the decoder's PARSE_BUFFER_MAX.
        maxPendingBytes: Number.MAX_SAFE_INTEGER,
        idleTimeoutMs: 0,
        restartOnError: false,
      });
    }
    const attempt = route === "unresolved" ? undefined : attempts.get(route.id);
    const remainingRows = attempt ? projections.get(attempt)?.remainingRows : 0;
    let catalogRows: Map<number, number | undefined> | undefined;
    if (route === "unresolved") {
      catalogRows = new Map();
      for (const [id, pending] of attempts) {
        const projection = projections.get(pending);
        if (typeof id === "number" && projection) {
          catalogRows.set(id, projection.remainingRows);
        }
      }
    }
    // Transfer an exclusively owned backing store; never detach a pooled Buffer or
    // the unread suffix of a transport chunk shared with notifications.
    const bytes =
      line.byteOffset === 0 &&
      line.byteLength === line.buffer.byteLength &&
      line.buffer instanceof ArrayBuffer
        ? new Uint8Array(line.buffer)
        : Uint8Array.from(line);
    const decoded = await this.pool.run(
      { bytes, route, remainingRows, catalogRows },
      {
        inputBytes: bytes.byteLength,
        transferList: (input) => [input.bytes.buffer],
      },
    );
    if (this.closed) {
      return undefined;
    }
    this.continuationRoute = decoded.pending ? route : undefined;
    return decoded;
  }

  close(error: Error): Promise<void> {
    this.closed = true;
    this.continuationRoute = undefined;
    return this.pool?.close(error) ?? Promise.resolve();
  }
}
