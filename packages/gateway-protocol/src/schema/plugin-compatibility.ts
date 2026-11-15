import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const PluginSdkDeprecationNoticeSchema = closedObject({
  code: Type.Literal("deprecated-sdk-api"),
  severity: Type.Literal("info"),
  message: NonEmptyString,
  removalDate: Type.Optional(NonEmptyString),
  migrationGuideUrl: NonEmptyString,
  apis: Type.Array(
    closedObject({
      id: NonEmptyString,
      displayName: NonEmptyString,
      replacement: NonEmptyString,
      removeAfter: Type.Optional(NonEmptyString),
    }),
  ),
});
