import type { Static } from "typebox";
import { Type } from "typebox";
import {
  USER_BACKGROUND_MAX_INPUT_BYTES,
  USER_BACKGROUND_MAX_OUTPUT_BYTES,
} from "./background-preferences.js";
import { closedObject } from "./closed-object.js";

const UserBackgroundAssetIdSchema = Type.String({ pattern: "^[A-Za-z0-9_-]{1,128}$" });
export const BackgroundPreferenceSchema = closedObject({
  source: Type.Union([
    closedObject({ kind: Type.Literal("none") }),
    closedObject({ kind: Type.Literal("theme") }),
    closedObject({ kind: Type.Literal("custom"), assetId: UserBackgroundAssetIdSchema }),
  ]),
  presentation: Type.Optional(Type.Union([Type.Literal("faded"), Type.Literal("full-bleed")])),
  showOnNewSession: Type.Boolean(),
  showInSessions: Type.Boolean(),
  visibility: Type.Number({ minimum: 0, maximum: 1 }),
});
export const UserBackgroundAssetSchema = closedObject({
  assetId: UserBackgroundAssetIdSchema,
  width: Type.Integer({ minimum: 1, maximum: 2560 }),
  height: Type.Integer({ minimum: 1, maximum: 2560 }),
  mime: Type.Literal("image/jpeg"),
  byteLength: Type.Integer({ minimum: 1, maximum: USER_BACKGROUND_MAX_OUTPUT_BYTES }),
});
export const UsersBackgroundGetParamsSchema = closedObject({});
const expected = {
  expectedAssetId: Type.Union([UserBackgroundAssetIdSchema, Type.Null()]),
  expectedPreference: Type.Union([BackgroundPreferenceSchema, Type.Null()]),
};
export const UsersBackgroundUploadParamsSchema = closedObject({
  imageBase64: Type.String({
    minLength: 4,
    maxLength: 4 * Math.ceil(USER_BACKGROUND_MAX_INPUT_BYTES / 3),
  }),
  ...expected,
});
export const UsersBackgroundRemoveParamsSchema = closedObject(expected);
export const UsersBackgroundResultSchema = Type.Union([
  closedObject({
    status: Type.Literal("ok"),
    asset: Type.Union([UserBackgroundAssetSchema, Type.Null()]),
    preference: Type.Union([BackgroundPreferenceSchema, Type.Null()]),
  }),
  closedObject({ status: Type.Literal("conflict") }),
  closedObject({ status: Type.Literal("no_durable_identity") }),
]);
export type UserBackgroundAsset = Static<typeof UserBackgroundAssetSchema>;
export type UsersBackgroundResult = Static<typeof UsersBackgroundResultSchema>;
export type UsersBackgroundUploadParams = Static<typeof UsersBackgroundUploadParamsSchema>;
export type UsersBackgroundRemoveParams = Static<typeof UsersBackgroundRemoveParamsSchema>;
