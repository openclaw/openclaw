import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** The release actually selected by the registry, independently of listing latest metadata. */
export const ClawHubSelectedReleaseSchema = closedObject({
  version: NonEmptyString,
  createdAt: Type.Optional(Type.Integer({ minimum: 0 })),
  changelog: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(NonEmptyString)),
});

/** Artifact availability is advisory; installation still rechecks integrity and policy. */
export const ClawHubDownloadabilitySchema = Type.Union([
  closedObject({ status: Type.Literal("downloadable") }),
  closedObject({ status: Type.Literal("unavailable"), reason: NonEmptyString }),
  closedObject({ status: Type.Literal("unknown"), reason: NonEmptyString }),
]);

export type ClawHubSelectedRelease = Static<typeof ClawHubSelectedReleaseSchema>;
export type ClawHubDownloadability = Static<typeof ClawHubDownloadabilitySchema>;

/** Presence of the selected plugin release's registry summary, README, and scan metadata. */
export const ClawHubPluginMetadataSchema = closedObject({
  manifest: Type.Union([Type.Literal("available"), Type.Literal("missing")]),
  readme: Type.Union([Type.Literal("available"), Type.Literal("missing")]),
  security: Type.Union([Type.Literal("available"), Type.Literal("missing")]),
});

export const ClawHubPluginConfigFieldSchema = closedObject({
  name: NonEmptyString,
  description: Type.Optional(Type.String()),
  required: Type.Boolean(),
  sensitive: Type.Boolean(),
});

export const ClawHubPluginMcpServerSchema = closedObject({
  name: NonEmptyString,
  url: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  transport: Type.Optional(
    Type.Union([Type.Literal("streamable-http"), Type.Literal("sse"), Type.Literal("stdio")]),
  ),
  auth: Type.Optional(
    Type.Union([Type.Literal("oauth"), Type.Literal("api-key"), Type.Literal("none")]),
  ),
  scope: Type.Optional(Type.String({ maxLength: 1000 })),
  setup: Type.Optional(Type.String({ maxLength: 2000 })),
  endpointRedacted: Type.Optional(Type.Boolean()),
});
