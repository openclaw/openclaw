import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

export const ModelAuthProfileIdSchema = Type.String({ minLength: 1, maxLength: 256 });

const ChatAccountSelectionSourceSchema = Type.Optional(
  Type.Union([Type.Literal("auto"), Type.Literal("user"), Type.Literal("user-link")]),
);
const ChatAccountSelectionLabelSchema = Type.String({ minLength: 1, maxLength: 256 });
/** Configured preference only; provider failover can use a different account. */
export const ChatAccountSelectionSchema = Type.Union([
  closedObject({ kind: Type.Literal("automatic"), label: ChatAccountSelectionLabelSchema }),
  closedObject({
    kind: Type.Literal("personal"),
    label: ChatAccountSelectionLabelSchema,
    // Collaborators see the person, not private credential identifiers or labels.
    authProfileId: Type.Optional(ModelAuthProfileIdSchema),
    source: ChatAccountSelectionSourceSchema,
  }),
  closedObject({
    kind: Type.Literal("shared"),
    label: ChatAccountSelectionLabelSchema,
    authProfileId: ModelAuthProfileIdSchema,
    source: ChatAccountSelectionSourceSchema,
  }),
]);

export type ChatAccountSelection = Static<typeof ChatAccountSelectionSchema>;
