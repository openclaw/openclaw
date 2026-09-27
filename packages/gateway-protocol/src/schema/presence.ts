import type { Static } from "typebox";
import { lazyCompile } from "../protocol-validator.js";
import { closedObject } from "./closed-object.js";

/** Interaction signal only; identity and time belong to the authenticated live connection. */
const PresenceActivityParamsSchema = closedObject({});
export type PresenceActivityParams = Static<typeof PresenceActivityParamsSchema>;
export const validatePresenceActivityParams = lazyCompile(PresenceActivityParamsSchema);
