import type { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { CodexPreparedServerNotification, JsonValue, RpcRequest } from "./protocol.js";
export type CodexAppServerServerRequest = Required<Pick<RpcRequest, "id" | "method">> &
  Pick<RpcRequest, "params">;
export type CodexThreadRouteScope = {
  threadId: string;
  turnId?: string;
};
export type CodexThreadRequestHandler = (
  request: CodexAppServerServerRequest,
  scope: CodexThreadRouteScope,
  signal: AbortSignal,
  setExecutionTimeoutMs?: (timeoutMs: number | null) => void,
) => Promise<JsonValue | undefined> | JsonValue | undefined;

export type CodexThreadNotificationHandler = (
  notification: CodexPreparedServerNotification,
  scope: CodexThreadRouteScope,
) => Promise<void> | void;
type CodexThreadNotificationReceivedHandler = (
  notification: CodexPreparedServerNotification,
  scope: CodexThreadRouteScope,
  receivedAtMs: number,
) => void;
export type CodexThreadRouteHandlers = {
  onNotificationReceived?: CodexThreadNotificationReceivedHandler;
  onNotification?: CodexThreadNotificationHandler;
  onRequest?: CodexThreadRequestHandler;
};

type Deferred = ReturnType<typeof createDeferred<void>>;
export type PendingNotification = {
  notification: CodexPreparedServerNotification;
  receivedAtMs: number;
  scope: CodexThreadRouteScope;
  receiptObserved?: true;
};
export type Route = {
  threadId: string;
  controller: AbortController;
  handlers?: CodexThreadRouteHandlers;
  released?: Error;
  ended: Deferred;
  activated: Deferred;
  gate: "open" | "armed" | "bound";
  binding?: Deferred;
  turnId?: string;
  nativeSuccessors?: boolean;
  retiredNativeTurnIds?: Set<string>;
  successorBinding?: Deferred;
  pending: PendingNotification[];
  notificationPause?: Promise<void>;
  notificationTail: Promise<void>;
  observedNativeTurn?: { id: string; completed: boolean };
  completedNativeTurnIds: Set<string>;
  ignoredTurnNotificationKeys: Set<string>;
  detachReleaseOn?: () => void;
};
