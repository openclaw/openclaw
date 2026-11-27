import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const PluginDiscoveryIconKeySchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
});

export const PluginDiscoveryCategorySchema = closedObject({
  slug: NonEmptyString,
  label: NonEmptyString,
  description: NonEmptyString,
  icon: PluginDiscoveryIconKeySchema,
  order: Type.Integer({ minimum: 0 }),
  pinnedPackages: Type.Optional(Type.Array(NonEmptyString, { uniqueItems: true })),
  // Continue the public overview selection, not the unfiltered category listing.
  previewCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
});
