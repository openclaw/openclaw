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
