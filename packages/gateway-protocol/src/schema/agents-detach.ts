import type { Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Detaches an agent from this Gateway while preserving its store and files. */
export const AgentsDetachParamsSchema = closedObject({
  agentId: NonEmptyString,
});

export type AgentsDetachParams = Static<typeof AgentsDetachParamsSchema>;
