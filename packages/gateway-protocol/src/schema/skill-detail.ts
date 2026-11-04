import { Type } from "typebox";
import { ClawHubDownloadabilitySchema, ClawHubSelectedReleaseSchema } from "./clawhub-listing.js";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Skill registry detail, latest version, metadata, and owner info. */
const SkillRegistrySetupSchema = Type.Array(
  closedObject({
    key: NonEmptyString,
    required: Type.Boolean(),
  }),
);
const SkillDetailUnavailableSchema = closedObject({
  status: Type.Literal("unavailable"),
  reason: NonEmptyString,
});

export const SkillsDetailResultSchema = closedObject({
  registry: Type.Optional(NonEmptyString),
  source: Type.Optional(Type.Literal("clawhub")),
  installRef: Type.Optional(NonEmptyString),
  selectedRelease: Type.Optional(Type.Union([ClawHubSelectedReleaseSchema, Type.Null()])),
  downloadability: Type.Optional(ClawHubDownloadabilitySchema),
  card: Type.Optional(
    Type.Union([
      closedObject({ status: Type.Literal("available"), content: Type.String() }),
      SkillDetailUnavailableSchema,
    ]),
  ),
  requirements: Type.Optional(
    Type.Union([
      closedObject({
        status: Type.Literal("available"),
        setup: SkillRegistrySetupSchema,
        os: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
        systems: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
        scope: Type.Literal("registry-setup"),
        note: NonEmptyString,
      }),
      SkillDetailUnavailableSchema,
    ]),
  ),
  security: Type.Optional(
    Type.Union([
      closedObject({
        status: Type.Literal("available"),
        scanStatus: NonEmptyString,
        hasWarnings: Type.Boolean(),
        hasScanResult: Type.Boolean(),
        checkedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        summary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        virustotalUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
      SkillDetailUnavailableSchema,
    ]),
  ),
  warnings: Type.Optional(Type.Array(Type.String())),
  skill: Type.Union([
    closedObject({
      slug: NonEmptyString,
      displayName: NonEmptyString,
      summary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      icon: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      topics: Type.Optional(Type.Array(Type.String())),
      stats: Type.Optional(Type.Record(Type.String(), Type.Number())),
      tags: Type.Optional(Type.Record(NonEmptyString, Type.String())),
      channel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      isOfficial: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
      createdAt: Type.Integer(),
      updatedAt: Type.Integer(),
    }),
    Type.Null(),
  ]),
  latestVersion: Type.Optional(
    Type.Union([
      closedObject({
        version: NonEmptyString,
        createdAt: Type.Integer(),
        changelog: Type.Optional(Type.String()),
        license: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
      Type.Null(),
    ]),
  ),
  metadata: Type.Optional(
    Type.Union([
      closedObject({
        setup: Type.Optional(SkillRegistrySetupSchema),
        os: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
        systems: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
      }),
      Type.Null(),
    ]),
  ),
  moderation: Type.Optional(
    Type.Union([
      closedObject({
        isSuspicious: Type.Boolean(),
        isMalwareBlocked: Type.Boolean(),
        verdict: Type.String(),
        reasonCodes: Type.Array(Type.String()),
        summary: Type.Union([Type.String(), Type.Null()]),
        engineVersion: Type.Union([Type.String(), Type.Null()]),
        updatedAt: Type.Union([Type.Number(), Type.Null()]),
      }),
      Type.Null(),
    ]),
  ),
  owner: Type.Optional(
    Type.Union([
      closedObject({
        handle: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
        userId: Type.Optional(NonEmptyString),
        displayName: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
        image: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        official: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
        channel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        isOfficial: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
      }),
      Type.Null(),
    ]),
  ),
});
