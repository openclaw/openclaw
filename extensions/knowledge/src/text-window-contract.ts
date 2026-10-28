import { Type } from "typebox";
import { TEXT_PAGE_MAX_CHARS } from "./limits.js";
/** Shared bounded history/recovery text windows, independent of file capacity. */
export const TextWindowInput = {
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  maxChars: Type.Optional(Type.Integer({ minimum: 256, maximum: TEXT_PAGE_MAX_CHARS })),
};
export const TextWindowContent = Type.Object({
  offset: Type.Integer(),
  totalChars: Type.Integer(),
  nextOffset: Type.Union([Type.Integer(), Type.Null()]),
});
const SnapshotContent = Type.Object({
  ...TextWindowContent.properties,
  hash: Type.String({ maxLength: 64 }),
});
export const RecoveryContent = Type.Object({
  before: Type.Union([SnapshotContent, Type.Null()]),
  proposed: SnapshotContent,
  displaced: Type.Union([SnapshotContent, Type.Null()]),
});
