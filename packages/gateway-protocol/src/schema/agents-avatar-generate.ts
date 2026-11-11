import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Generates an avatar preview from text explicitly supplied by its creator. */
export const AgentsAvatarGenerateParamsSchema = closedObject({
  agentId: NonEmptyString,
  prompt: Type.String({ minLength: 1, maxLength: 8_000, pattern: "\\S" }),
});

/** The Gateway renders the static SVG; generating does not change the saved identity. */
export const AgentsAvatarGenerateResultSchema = closedObject({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.String({ minLength: 1, maxLength: 2_000 }),
  svg: Type.String({ minLength: 1, maxLength: 128_000 }),
});

export type AgentsAvatarGenerateParams = Static<typeof AgentsAvatarGenerateParamsSchema>;
export type AgentsAvatarGenerateResult = Static<typeof AgentsAvatarGenerateResultSchema>;
