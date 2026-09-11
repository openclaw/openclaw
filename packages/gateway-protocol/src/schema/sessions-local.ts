// Live local sessions: enrollment of a paired device's native session source
// under a verified team profile, plus per-thread unshare.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const LocalSessionSourceDescriptorSchema = closedObject({
  pluginId: NonEmptyString,
  sourceId: NonEmptyString,
  label: NonEmptyString,
  /** Node command a device must advertise to offer this source. */
  command: NonEmptyString,
});
export type LocalSessionSourceDescriptor = Static<typeof LocalSessionSourceDescriptorSchema>;

export const LocalSessionEnrollmentStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("active"),
  Type.Literal("declined"),
  Type.Literal("revoked"),
  Type.Literal("expired"),
]);

export const LocalSessionEnrollmentSchema = closedObject({
  enrollmentId: NonEmptyString,
  ownerProfileId: NonEmptyString,
  ownerLabel: NonEmptyString,
  deviceId: NonEmptyString,
  pluginId: NonEmptyString,
  sourceId: NonEmptyString,
  agentId: NonEmptyString,
  state: LocalSessionEnrollmentStateSchema,
  requestedAtMs: Type.Integer({ minimum: 0 }),
  expiresAtMs: Type.Integer({ minimum: 0 }),
  confirmedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  endedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  reason: Type.Optional(Type.String()),
  setupId: Type.Optional(NonEmptyString),
});
export type LocalSessionEnrollment = Static<typeof LocalSessionEnrollmentSchema>;

export const SessionsLocalSourcesParamsSchema = closedObject({});
export const SessionsLocalSourcesResultSchema = closedObject({
  sources: Type.Array(LocalSessionSourceDescriptorSchema),
});

export const SessionsLocalEnrollmentsParamsSchema = closedObject({
  deviceId: Type.Optional(NonEmptyString),
});
export const SessionsLocalEnrollmentsResultSchema = closedObject({
  enrollments: Type.Array(LocalSessionEnrollmentSchema),
});

export const SessionsLocalEnrollParamsSchema = closedObject({
  deviceId: NonEmptyString,
  sourceId: NonEmptyString,
  agentId: NonEmptyString,
});
export const SessionsLocalEnrollResultSchema = closedObject({
  enrollment: LocalSessionEnrollmentSchema,
});
export type SessionsLocalEnrollParams = Static<typeof SessionsLocalEnrollParamsSchema>;

export const SessionsLocalRevokeParamsSchema = closedObject({ enrollmentId: NonEmptyString });
export const SessionsLocalRevokeResultSchema = SessionsLocalEnrollResultSchema;
export type SessionsLocalRevokeParams = Static<typeof SessionsLocalRevokeParamsSchema>;

export const SessionsLocalUnshareParamsSchema = closedObject({ sessionKey: NonEmptyString });
export const SessionsLocalUnshareResultSchema = closedObject({ ok: Type.Literal(true) });
export type SessionsLocalUnshareParams = Static<typeof SessionsLocalUnshareParamsSchema>;

export const SessionsLocalEnrollmentEventSchema = closedObject({
  enrollment: LocalSessionEnrollmentSchema,
});

/** Receipt transitions for one message sent into a live local session. */
export const SessionLocalInputEventSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: NonEmptyString,
  inputId: NonEmptyString,
  state: Type.Union([
    Type.Literal("accepted"),
    Type.Literal("submitted"),
    Type.Literal("committed"),
    Type.Literal("rejected"),
  ]),
  reason: Type.Optional(Type.String()),
});
export type SessionLocalInputEvent = Static<typeof SessionLocalInputEventSchema>;

/** A signed-in person mints their own connect link that shares the named sources. */
export const SessionsLocalConnectCodeParamsSchema = closedObject({
  sourceIds: Type.Array(NonEmptyString, { minItems: 1, maxItems: 8 }),
  agentId: NonEmptyString,
});
export const SessionsLocalConnectCodeResultSchema = closedObject({
  setupId: NonEmptyString,
  joinUrl: NonEmptyString,
  /** Pasteable on the laptop: `npx openclaw connect <joinUrl> --share <source>...`. */
  command: NonEmptyString,
  expiresAtMs: Type.Integer({ minimum: 0 }),
  sources: Type.Array(LocalSessionSourceDescriptorSchema),
});
export type SessionsLocalConnectCodeParams = Static<typeof SessionsLocalConnectCodeParamsSchema>;
export type SessionsLocalConnectCodeResult = Static<typeof SessionsLocalConnectCodeResultSchema>;
