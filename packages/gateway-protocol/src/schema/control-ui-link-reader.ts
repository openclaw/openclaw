import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const ControlUiLinkReaderMetadataSchema = closedObject({
  hosts: Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { minItems: 1, maxItems: 16 }),
  pathPattern: Type.String({ minLength: 2, maxLength: 1024 }),
  detailMethod: Type.String({ minLength: 1, maxLength: 128 }),
  previewMethod: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});

export const ControlUiLinkReaderDescriptorSchema = closedObject({
  pluginId: NonEmptyString,
  id: NonEmptyString,
  label: NonEmptyString,
  icon: Type.Optional(Type.String()),
  linkReader: ControlUiLinkReaderMetadataSchema,
});
