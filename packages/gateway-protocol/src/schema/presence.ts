import { type Static, Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const PresenceQueryParamsSchema = closedObject({
  action: Type.Optional(
    Type.Union([Type.Literal("list"), Type.Literal("person"), Type.Literal("device")], {
      description:
        "List connected people (default), inspect a person, or inspect a connected device.",
    }),
  ),
  person: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 320,
      description:
        "For person: me, a returned person/profile ID, or an exact unambiguous display name.",
    }),
  ),
  deviceId: Type.Optional(
    Type.String({
      minLength: 1,
      description: "For device: the exact presence device ID returned by this tool.",
    }),
  ),
  include: Type.Optional(
    Type.Array(
      Type.Union([Type.Literal("devices"), Type.Literal("network"), Type.Literal("location")]),
      {
        uniqueItems: true,
        maxItems: 3,
        description:
          "Optional device details. Network includes IP; location includes approximate IP location without requesting GPS. Each option includes devices.",
      },
    ),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      description: "Maximum people returned (default 50, maximum 100); truncation is reported.",
    }),
  ),
});

const PresenceActivitySchema = closedObject({
  at: Type.Integer({ minimum: 0 }),
  source: Type.Union([
    Type.Literal("openclaw-interaction"),
    Type.Literal("app-input"),
    Type.Literal("system-input"),
  ]),
  deviceId: NonEmptyString,
});

export const PresenceLocationSchema = closedObject({
  source: Type.Literal("ip"),
  status: Type.Union([
    Type.Literal("found"),
    Type.Literal("not-found"),
    Type.Literal("unavailable"),
  ]),
  city: Type.Optional(NonEmptyString),
  region: Type.Optional(NonEmptyString),
  country: Type.Optional(NonEmptyString),
  countryCode: Type.Optional(NonEmptyString),
  attribution: Type.Optional(closedObject({ text: NonEmptyString, url: NonEmptyString })),
});

export const PresenceDeviceSchema = closedObject({
  id: NonEmptyString,
  nodeId: Type.Optional(NonEmptyString),
  name: NonEmptyString,
  kind: Type.Union([Type.Literal("node"), Type.Literal("client")]),
  personIds: Type.Array(NonEmptyString),
  online: Type.Literal(true),
  activity: Type.Union([PresenceActivitySchema, Type.Null()]),
  connections: Type.Array(
    closedObject({
      id: NonEmptyString,
      clientId: Type.Optional(NonEmptyString),
      platform: Type.Optional(NonEmptyString),
      deviceFamily: Type.Optional(NonEmptyString),
      timeZone: Type.Optional(NonEmptyString),
      network: Type.Optional(closedObject({ ip: Type.Union([NonEmptyString, Type.Null()]) })),
      location: Type.Optional(PresenceLocationSchema),
    }),
  ),
});

export const PresencePersonSchema = closedObject({
  id: NonEmptyString,
  profileId: Type.Optional(NonEmptyString),
  name: NonEmptyString,
  online: Type.Literal(true),
  onlineSince: Type.Optional(Type.Integer({ minimum: 0 })),
  activity: Type.Union([PresenceActivitySchema, Type.Null()]),
  deviceCount: Type.Integer({ minimum: 0 }),
  devices: Type.Optional(Type.Array(PresenceDeviceSchema)),
});

export const PresenceQueryResultSchema = closedObject({
  observedAt: Type.Integer({ minimum: 0 }),
  status: Type.Union([
    Type.Literal("ok"),
    Type.Literal("ambiguous"),
    Type.Literal("not-found"),
    Type.Literal("identity-unavailable"),
  ]),
  people: Type.Array(PresencePersonSchema),
  devices: Type.Optional(Type.Array(PresenceDeviceSchema)),
  totalPeople: Type.Integer({ minimum: 0 }),
  truncated: Type.Boolean(),
  message: Type.Optional(NonEmptyString),
});

export type PresenceQueryParams = Static<typeof PresenceQueryParamsSchema>;
export type PresenceQueryResult = Static<typeof PresenceQueryResultSchema>;
export type PresencePerson = Static<typeof PresencePersonSchema>;
export type PresenceDevice = Static<typeof PresenceDeviceSchema>;
export type PresenceLocation = Static<typeof PresenceLocationSchema>;
