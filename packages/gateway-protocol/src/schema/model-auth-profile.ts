import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Changes only the display label of one stored model-auth account. */
export const ModelsAuthProfileRenameParamsSchema = closedObject({
  agentId: NonEmptyString,
  profileId: NonEmptyString,
  displayName: Type.String({ maxLength: 80, pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]*$" }),
});
