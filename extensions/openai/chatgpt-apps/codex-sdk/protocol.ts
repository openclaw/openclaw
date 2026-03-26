import type {
  ClientNotification,
  ClientRequest,
  RequestId,
  ServerNotification,
  ServerRequest,
} from "./generated/protocol/index.js";

export type { RequestId };

export type ClientMethod = ClientRequest["method"];
export type ClientRequestEnvelope<M extends ClientMethod = ClientMethod> = Extract<
  ClientRequest,
  { method: M }
>;
export type ClientRequestPayload<M extends ClientMethod> = ClientRequestEnvelope<M>["params"];

export type ClientNotificationMethod = ClientNotification["method"];
export type ClientNotificationEnvelope<
  M extends ClientNotificationMethod = ClientNotificationMethod,
> = Extract<ClientNotification, { method: M }>;
export type ClientNotificationPayload<M extends ClientNotificationMethod> =
  ClientNotificationEnvelope<M> extends { params: infer P } ? P : undefined;

export type NotificationMethod = ServerNotification["method"];
export type ServerNotificationEnvelope<M extends NotificationMethod = NotificationMethod> = Extract<
  ServerNotification,
  { method: M }
>;
export type NotificationPayload<M extends NotificationMethod> =
  ServerNotificationEnvelope<M>["params"];

export type ServerRequestMethod = ServerRequest["method"];
export type ServerRequestEnvelope<M extends ServerRequestMethod = ServerRequestMethod> = Extract<
  ServerRequest,
  { method: M }
>;
export type ServerRequestPayload<M extends ServerRequestMethod> =
  ServerRequestEnvelope<M>["params"];
