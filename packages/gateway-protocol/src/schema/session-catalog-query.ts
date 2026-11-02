import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { stringLiteralUnion } from "./string-literal-union.js";

/** A relationship target narrows published data; it never represents caller authority. */
export const SessionCatalogSourceProfileRelationSchema = closedObject({
  relationship: stringLiteralUnion(["owned", "involving"]),
  target: Type.Union([
    closedObject({
      type: Type.Literal("profile"),
      id: Type.String({ minLength: 1, maxLength: 200 }),
    }),
    closedObject({
      type: Type.Literal("github-account"),
      id: Type.String({ pattern: "^[1-9][0-9]*$", maxLength: 32 }),
    }),
  ]),
});

export const SessionCatalogProfileRelationSchema = closedObject({
  relationship: SessionCatalogSourceProfileRelationSchema.properties.relationship,
  target: Type.Union([
    SessionCatalogSourceProfileRelationSchema.properties.target,
    closedObject({ type: Type.Literal("me") }),
    closedObject({
      type: Type.Literal("local-profile"),
      id: Type.String({ minLength: 1, maxLength: 200 }),
    }),
  ]),
});

export type SessionCatalogSourceProfileRelation = Static<
  typeof SessionCatalogSourceProfileRelationSchema
>;
export type SessionCatalogProfileRelation = Static<typeof SessionCatalogProfileRelationSchema>;
