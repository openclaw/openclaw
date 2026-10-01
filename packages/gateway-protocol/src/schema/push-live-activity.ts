import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

// Match native scalar bounds, not UTF-16 units or grapheme clusters.
const identifier = (maxLength: number) =>
  Type.String({
    minLength: 1,
    maxLength,
    pattern: `^(?=[\\s\\S]{1,${maxLength}}$)[^\\u0000-\\u001f\\uD800-\\uDFFF]+$`,
  });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const unixMilliseconds = Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const agentId = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$", maxLength: 64 });

export const PushLiveActivityBindingSchema = closedObject({
  gatewayId: identifier(256),
  deviceId: identifier(256),
  nodeId: identifier(256),
  pairingGeneration: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  profileId: identifier(128),
  agentId,
  sessionKey: identifier(512),
  sessionId: identifier(128),
  lifecycleRevision: Type.Union([identifier(256), Type.Null()]),
  publicRunId: identifier(256),
});
const correlation = {
  binding: PushLiveActivityBindingSchema,
  sourceIncarnation: identifier(1024),
};
const fact = {
  sourceIncarnation: identifier(1024),
  sequence: revision,
  observedAtMs: unixMilliseconds,
  startedAtMs: Type.Optional(unixMilliseconds),
};
export const PushLiveActivitySnapshotSchema = Type.Union([
  closedObject({
    ...fact,
    status: Type.Union([
      Type.Literal("running"),
      Type.Literal("toolRunning"),
      Type.Literal("approvalNeeded"),
    ]),
  }),
  closedObject({
    ...fact,
    status: Type.Union([
      Type.Literal("done"),
      Type.Literal("failed"),
      Type.Literal("killed"),
      Type.Literal("timeout"),
    ]),
    endedAtMs: Type.Optional(unixMilliseconds),
  }),
]);
const destination = {
  topic: identifier(255),
  environment: Type.Union([Type.Literal("sandbox"), Type.Literal("production")]),
};
export const PushLiveActivityDestinationSchema = Type.Union([
  closedObject({
    ...destination,
    transport: Type.Literal("direct"),
    token: Type.String({ minLength: 32, maxLength: 512, pattern: "^[0-9a-f]+$" }),
  }),
  closedObject({
    ...destination,
    transport: Type.Literal("relay"),
    relayHandle: identifier(256),
    sendGrant: identifier(1024),
    installationId: identifier(256),
    relayOrigin: identifier(2048),
    relayRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  }),
]);

export const PushLiveActivityPrepareParamsSchema = closedObject({
  key: identifier(512),
  agentId: Type.Optional(agentId),
  sessionId: identifier(128),
  publicRunId: identifier(256),
});
export const PushLiveActivityPrepareResultSchema = closedObject({
  ...correlation,
  snapshot: PushLiveActivitySnapshotSchema,
});
export const PushLiveActivityRegisterParamsSchema = closedObject({
  activityId: identifier(256),
  expected: closedObject(correlation),
  destination: PushLiveActivityDestinationSchema,
});
export const PushLiveActivityRotateParamsSchema = closedObject({
  registrationId: identifier(256),
  expectedRevision: revision,
  destination: PushLiveActivityDestinationSchema,
});
export const PushLiveActivityRevokeParamsSchema = closedObject({
  registrationId: identifier(256),
  expectedRevision: revision,
});
export const PushLiveActivityRegistrationResultSchema = closedObject({
  registrationId: identifier(256),
  activityId: identifier(256),
  ...correlation,
  state: Type.Union([
    Type.Literal("active"),
    Type.Literal("terminal_pending"),
    Type.Literal("tombstone"),
  ]),
  rotationRevision: revision,
  leaseExpiresAtMs: unixMilliseconds,
});
export const PushLiveActivityRevokeResultSchema = closedObject({ removed: Type.Boolean() });
export const PushLiveActivityDiscoverParamsSchema = closedObject({
  activityId: identifier(256),
  selectors: closedObject({
    gatewayDeviceId: identifier(256),
    deviceId: identifier(256),
    profileId: identifier(128),
    agentId,
    sessionKey: identifier(512),
    sessionId: identifier(128),
    runId: identifier(256),
  }),
});
export const PushLiveActivityDiscoverResultSchema = Type.Union([
  closedObject({ status: Type.Literal("unknown") }),
  closedObject({
    status: Type.Literal("found"),
    registration: PushLiveActivityRegistrationResultSchema,
  }),
]);

export type PushLiveActivityDiscoverParams = Static<typeof PushLiveActivityDiscoverParamsSchema>;
export type PushLiveActivityDiscoverResult = Static<typeof PushLiveActivityDiscoverResultSchema>;
export type PushLiveActivityPrepareParams = Static<typeof PushLiveActivityPrepareParamsSchema>;
export type PushLiveActivityPrepareResult = Static<typeof PushLiveActivityPrepareResultSchema>;
export type PushLiveActivityRegisterParams = Static<typeof PushLiveActivityRegisterParamsSchema>;
export type PushLiveActivityRotateParams = Static<typeof PushLiveActivityRotateParamsSchema>;
export type PushLiveActivityRevokeParams = Static<typeof PushLiveActivityRevokeParamsSchema>;
export type PushLiveActivityRegistrationResult = Static<
  typeof PushLiveActivityRegistrationResultSchema
>;
