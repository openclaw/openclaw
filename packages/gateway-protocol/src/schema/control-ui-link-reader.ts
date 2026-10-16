import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const ControlUiLinkReaderMetadataSchema = closedObject({
  /** Exact lowercase DNS hostnames; no schemes, ports, or wildcards. */
  hosts: Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { minItems: 1, maxItems: 16 }),
  /** Anchored pathname regular expression authored by the installed trusted plugin. */
  pathPattern: Type.String({ minLength: 2, maxLength: 1024 }),
  /** Same-plugin gateway method requiring operator.read. */
  detailMethod: Type.String({ minLength: 1, maxLength: 128 }),
  previewMethod: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  /** Optional same-plugin read method resolving inline images without browser CORS. */
  imageMethod: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});

export const ControlUiLinkReaderDescriptorSchema = closedObject({
  pluginId: NonEmptyString,
  id: NonEmptyString,
  label: NonEmptyString,
  /** Existing Control UI icon name; unknown names use the generic link icon. */
  icon: Type.Optional(Type.String()),
  linkReader: ControlUiLinkReaderMetadataSchema,
});
