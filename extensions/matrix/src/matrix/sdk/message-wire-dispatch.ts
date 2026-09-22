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
  private readonly guards = new Map<string, MatrixMessageWireDispatchGuard>();

  beforeRequest(resource: RequestInfo | URL, init?: RequestInit): Promise<void> | undefined {
    const dispatch = resolveMessageWireDispatch(resource, init);
    return dispatch
      ? Promise.resolve(this.guards.get(dispatch.transactionId)?.(dispatch))
      : undefined;
  }

  async run<T>(params: {
    transactionId?: string;
    guard?: MatrixMessageWireDispatchGuard;
    run: () => Promise<T>;
  }): Promise<T> {
    if (!params.transactionId || !params.guard) {
      return await params.run();
    }
    if (this.guards.has(params.transactionId)) {
      throw new Error(`Matrix transaction ${params.transactionId} already has a dispatch guard`);
    }
    this.guards.set(params.transactionId, params.guard);
    try {
      return await params.run();
    } finally {
      this.guards.delete(params.transactionId);
    }
  }
}
