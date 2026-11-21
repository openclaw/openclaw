import type { Static } from "typebox";
import { Type } from "typebox";
import type { SchemaContract } from "../schema-contract.js";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/**
 * Push-notification protocol schemas.
 *
 * APNS test schemas exercise native push routing; Web Push schemas describe the
 * browser subscription lifecycle exposed by the gateway.
 */
const ApnsEnvironmentSchema = Type.String({ enum: ["sandbox", "production"] });

export const PushTestParamsSchema = closedObject({
  nodeId: NonEmptyString,
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  environment: Type.Optional(ApnsEnvironmentSchema),
});

export const PushTestResultSchema = closedObject({
  ok: Type.Boolean(),
  status: Type.Integer(),
  apnsId: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  tokenSuffix: Type.String(),
  topic: Type.String(),
  environment: ApnsEnvironmentSchema,
  transport: Type.String({ enum: ["direct", "relay"] }),
});

const WebPushKeysSchema = closedObject({
  p256dh: Type.String({ minLength: 1, maxLength: 512 }),
  auth: Type.String({ minLength: 1, maxLength: 512 }),
});

export const WebPushNotificationCategorySchema = Type.String({
  enum: [
    "approval-requested",
    "agent-finished",
    "agent-question",
    "human-mentioned",
    "scheduled-task-failed",
  ],
});

export const WebPushDetailLevelSchema = Type.String({
  enum: ["private", "identified", "detailed"],
});

const WebPushCategoryPreferencesSchema = closedObject({
  approvalRequested: Type.Boolean(),
  agentFinished: Type.Boolean(),
  agentQuestion: Type.Boolean(),
  humanMentioned: Type.Optional(Type.Boolean()),
  scheduledTaskFailed: Type.Boolean(),
});

const WebPushQuietHoursSchema = closedObject({
  enabled: Type.Boolean(),
  startMinute: Type.Integer({ minimum: 0, maximum: 1439 }),
  endMinute: Type.Integer({ minimum: 0, maximum: 1439 }),
  timeZone: Type.String({ minLength: 1, maxLength: 128 }),
});

export const WebPushNotificationPreferencesSchema = closedObject({
  categories: WebPushCategoryPreferencesSchema,
  detailLevel: WebPushDetailLevelSchema,
  quietHours: WebPushQuietHoursSchema,
  agentIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128 }),
});

export const WebPushDevicePreferencesSchema = closedObject({
  enabled: Type.Boolean(),
  label: Type.String({ maxLength: 80 }),
  categories: Type.Optional(
    closedObject({
      approvalRequested: Type.Optional(Type.Boolean()),
      agentFinished: Type.Optional(Type.Boolean()),
      agentQuestion: Type.Optional(Type.Boolean()),
      humanMentioned: Type.Optional(Type.Boolean()),
      scheduledTaskFailed: Type.Optional(Type.Boolean()),
    }),
  ),
  detailLevel: Type.Optional(WebPushDetailLevelSchema),
  quietHours: Type.Optional(WebPushQuietHoursSchema),
  agentIds: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128 }),
  ),
});

export const WebPushVapidPublicKeyParamsSchema = closedObject({});

export const WebPushSubscribeParamsSchema = closedObject({
  endpoint: Type.String({ minLength: 1, maxLength: 2048, pattern: "^https://" }),
  keys: WebPushKeysSchema,
});

export const WebPushUnsubscribeParamsSchema = closedObject({
  endpoint: Type.String({ minLength: 1, maxLength: 2048, pattern: "^https://" }),
});

/** Request payload for sending a test Web Push notification to current subscriptions. */
export const WebPushTestParamsSchema = closedObject({
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
});

/**
 * Request payload for a preference-aware Web Push to one user profile's current browsers.
 *
 * Recipients come from the Gateway's subscription authority, never from the caller.
 * Approval requests keep their own delivery owner and are not accepted here.
 */
export const WebPushSendParamsSchema = closedObject({
  profileId: Type.String({ minLength: 1, maxLength: 256 }),
  category: Type.Union([
    Type.Literal("agent-finished"),
    Type.Literal("agent-question"),
    Type.Literal("human-mentioned"),
    Type.Literal("scheduled-task-failed"),
  ]),
  /** Collapses repeated notifications on the device; namespaced by the Gateway. */
  tag: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9._:-]{1,64}$" })),
  /**
   * Control UI path opened on click, relative to the Control UI base path. No query or
   * fragment (Control UI reads startup settings such as `token` and `gatewayUrl` from
   * them), no empty segments, and no dot segments, including percent-encoded ones.
   */
  path: Type.Optional(
    Type.String({
      maxLength: 512,
      pattern: "^(?!.*//)(?!.*/(?:\\.|%2[Ee]){1,2}(?:/|$))[A-Za-z0-9][A-Za-z0-9._~%/-]*$",
    }),
  ),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  body: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  urgency: Type.Optional(
    Type.Union([
      Type.Literal("very-low"),
      Type.Literal("low"),
      Type.Literal("normal"),
      Type.Literal("high"),
    ]),
  ),
  ttlSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 86_400 })),
});

export const WebPushSendResultSchema = closedObject({
  sent: Type.Integer({ minimum: 0 }),
  failed: Type.Integer({ minimum: 0 }),
  skipped: Type.Integer({ minimum: 0 }),
  pruned: Type.Integer({ minimum: 0 }),
});

export const WebPushPreferencesGetParamsSchema = closedObject({
  endpoint: Type.String({ minLength: 1, maxLength: 2048, pattern: "^https://" }),
});

const WebPushPreferencesEndpointSchema = Type.String({
  minLength: 1,
  maxLength: 2048,
  pattern: "^https://",
});

export const WebPushPreferencesSetParamsSchema = Type.Union([
  closedObject({
    endpoint: WebPushPreferencesEndpointSchema,
    scope: Type.Literal("user"),
    preferences: WebPushNotificationPreferencesSchema,
  }),
  closedObject({
    endpoint: WebPushPreferencesEndpointSchema,
    scope: Type.Literal("device"),
    preferences: WebPushDevicePreferencesSchema,
  }),
]);

export type WebPushVapidPublicKeyParams = Record<string, never>;
/** Browser PushSubscription subset persisted by the gateway. */
export type WebPushSubscribeParams = Static<typeof WebPushSubscribeParamsSchema>;
export type WebPushUnsubscribeParams = Static<typeof WebPushUnsubscribeParamsSchema>;
export type WebPushTestParams = SchemaContract<Static<typeof WebPushTestParamsSchema>>;
export type WebPushSendParams = Static<typeof WebPushSendParamsSchema>;
export type WebPushSendResult = Static<typeof WebPushSendResultSchema>;
export type WebPushNotificationCategory = Static<typeof WebPushNotificationCategorySchema>;
export type WebPushDetailLevel = Static<typeof WebPushDetailLevelSchema>;
export type WebPushNotificationPreferences = Static<typeof WebPushNotificationPreferencesSchema>;
export type WebPushDevicePreferences = Static<typeof WebPushDevicePreferencesSchema>;
export type WebPushPreferencesGetParams = Static<typeof WebPushPreferencesGetParamsSchema>;
export type WebPushPreferencesSetParams = Static<typeof WebPushPreferencesSetParamsSchema>;

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type PushTestParams = Static<typeof PushTestParamsSchema>;
export type PushTestResult = Static<typeof PushTestResultSchema>;
