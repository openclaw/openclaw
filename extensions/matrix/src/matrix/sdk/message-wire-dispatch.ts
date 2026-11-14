import { MatrixError } from "matrix-js-sdk/lib/http-api/errors.js";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";

export type MatrixMessageWireDispatch = {
  roomId: string;
  eventType: "m.room.message" | "m.room.encrypted";
  transactionId: string;
  requestPath: string;
};

type MatrixMessageWireDispatchGuard = (dispatch: MatrixMessageWireDispatch) => Promise<void>;

function resolveMessageWireDispatch(
  resource: RequestInfo | URL,
  init?: RequestInit,
): MatrixMessageWireDispatch | null {
  const method = (
    init?.method ?? (resource instanceof Request ? resource.method : "GET")
  ).toUpperCase();
  if (method !== "PUT") {
    return null;
  }
  const rawUrl =
    typeof resource === "string"
      ? resource
      : resource instanceof URL
        ? resource.href
        : resource.url;
  const segments = new URL(rawUrl).pathname.split("/").filter(Boolean);
  const roomsIndex = segments.lastIndexOf("rooms");
  if (roomsIndex < 0 || segments[roomsIndex + 2] !== "send" || segments.length !== roomsIndex + 5) {
    return null;
  }
  const eventType = decodeURIComponent(segments[roomsIndex + 3] ?? "");
  if (eventType !== "m.room.message" && eventType !== "m.room.encrypted") {
    return null;
  }
  return {
    roomId: decodeURIComponent(segments[roomsIndex + 1] ?? ""),
    eventType,
    transactionId: decodeURIComponent(segments[roomsIndex + 4] ?? ""),
    requestPath: new URL(rawUrl).pathname,
  };
}

export class MatrixMessageWireDispatchGuards {
  private readonly guards = new Map<
    string,
    {
      guard?: MatrixMessageWireDispatchGuard;
      assertCurrent?: () => void;
      currentnessRejected?: true;
      requestCount: number;
    }
  >();

  captureCurrentness(
    resource: RequestInfo | URL,
    init: RequestInit | undefined,
    fallback: (() => void) | undefined,
  ): (() => void) | undefined {
    const dispatch = resolveMessageWireDispatch(resource, init);
    const entry = dispatch ? this.guards.get(dispatch.transactionId) : undefined;
    // The SDK scheduler can process another sender's event in the first sender's context.
    if (!entry) {
      return fallback;
    }
    const assertCurrent = entry.assertCurrent;
    return assertCurrent
      ? () => {
          try {
            assertCurrent();
          } catch (error) {
            entry.currentnessRejected = true;
            throw error;
          }
        }
      : undefined;
  }

  wasCurrentnessRejected(transactionId: string | undefined): boolean {
    return (
      transactionId !== undefined && this.guards.get(transactionId)?.currentnessRejected === true
    );
  }

  beforeRequest(resource: RequestInfo | URL, init?: RequestInit): Promise<void> | undefined {
    const dispatch = resolveMessageWireDispatch(resource, init);
    const entry = dispatch ? this.guards.get(dispatch.transactionId) : undefined;
    if (!dispatch || !entry) {
      return undefined;
    }
    entry.requestCount++;
    return Promise.resolve(entry.guard?.(dispatch));
  }

  async run<T>(params: {
    transactionId?: string;
    guard?: MatrixMessageWireDispatchGuard;
    assertCurrent?: () => void;
    previousAttempt?: boolean;
    run: () => Promise<T>;
  }): Promise<T> {
    if (!params.transactionId) {
      return await params.run();
    }
    if (this.guards.has(params.transactionId)) {
      throw new Error(`Matrix transaction ${params.transactionId} already has a dispatch guard`);
    }
    const entry = {
      guard: params.guard,
      assertCurrent: params.assertCurrent,
      requestCount: 0,
    };
    this.guards.set(params.transactionId, entry);
    try {
      return await params.run();
    } catch (error) {
      // Only the first wire request can prove that this new event was rejected.
      // A retry/redirect or an existing SDK event may have reached the room.
      if (
        !params.previousAttempt &&
        entry.requestCount === 1 &&
        error instanceof MatrixError &&
        error.httpStatus === 403
      ) {
        throw new PlatformMessageNotDispatchedError(error.message, {
          cause: error,
          retryable: false,
        });
      }
      throw error;
    } finally {
      this.guards.delete(params.transactionId);
    }
  }
}
