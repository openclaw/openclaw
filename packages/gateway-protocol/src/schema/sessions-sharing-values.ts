import type { Static } from "typebox";
import { Type } from "typebox";
import { stringLiteralUnion } from "./string-literal-union.js";

export { SESSION_VISIBILITY_VALUES } from "./sessions-sharing-constants.js";

export const SessionVisibilitySchema = Type.Union([
  Type.Literal("shared"),
  Type.Literal("read-only"),
  Type.Literal("suggest"),
  Type.Literal("draft"),
]);

export const SessionMemberPermissionLevelSchema = stringLiteralUnion(["read", "suggest", "send"]);

export const SessionSharingRoleSchema = Type.Union([
  Type.Literal("admin"),
  Type.Literal("owner"),
  Type.Literal("member"),
  Type.Literal("viewer"),
]);

export type SessionVisibility = Static<typeof SessionVisibilitySchema>;
export type SessionSharingRole = Static<typeof SessionSharingRoleSchema>;
