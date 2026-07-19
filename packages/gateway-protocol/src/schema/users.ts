// Gateway Protocol schemas for durable user profiles and email aliases.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const UserProfileIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const UserProfileDisplayNameSchema = Type.String({ maxLength: 256 });
export const UserProfileAvatarMimeSchema = Type.Union([
  Type.Literal("image/png"),
  Type.Literal("image/jpeg"),
  Type.Literal("image/webp"),
]);

export const UserProfileSchema = closedObject({
  id: UserProfileIdSchema,
  displayName: Type.Union([UserProfileDisplayNameSchema, Type.Null()]),
  avatarMime: Type.Union([UserProfileAvatarMimeSchema, Type.Null()]),
  mergedInto: Type.Union([UserProfileIdSchema, Type.Null()]),
  createdAt: Type.Integer({ minimum: 0 }),
  updatedAt: Type.Integer({ minimum: 0 }),
  emails: Type.Array(NonEmptyString),
  hasAvatar: Type.Boolean(),
});

export const UsersListParamsSchema = closedObject({});
export const UsersListResultSchema = closedObject({ profiles: Type.Array(UserProfileSchema) });

export const UsersLinkEmailParamsSchema = closedObject({
  email: Type.String({ minLength: 1, maxLength: 320 }),
  targetProfileId: UserProfileIdSchema,
});

export const UsersSetDisplayNameParamsSchema = closedObject({
  profileId: UserProfileIdSchema,
  displayName: Type.Union([UserProfileDisplayNameSchema, Type.Null()]),
});

export const UsersSetAvatarParamsSchema = closedObject({
  profileId: UserProfileIdSchema,
  mime: UserProfileAvatarMimeSchema,
  avatarBase64: Type.String({ minLength: 1, maxLength: 700_000 }),
});

export type UserProfile = Static<typeof UserProfileSchema>;
export type UsersListParams = Static<typeof UsersListParamsSchema>;
export type UsersListResult = Static<typeof UsersListResultSchema>;
export type UsersLinkEmailParams = Static<typeof UsersLinkEmailParamsSchema>;
export type UsersSetDisplayNameParams = Static<typeof UsersSetDisplayNameParamsSchema>;
export type UsersSetAvatarParams = Static<typeof UsersSetAvatarParamsSchema>;
