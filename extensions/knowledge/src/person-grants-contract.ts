import { Type, type Static } from "typebox";
import { AGENT_ID, STORE_KEY } from "./stores-contract.js";

const profileId = Type.String({ minLength: 1, maxLength: 200 });
const agent = Type.String({ pattern: AGENT_ID });
const space = Type.String({ pattern: STORE_KEY });
const access = Type.Union([Type.Literal("read"), Type.Literal("read-write")]);

/** One selected space, local to a store and a verified person; never a union. */
export const PersonGrant = Type.Object(
  { profileId, agent, binding: Type.String({ maxLength: 120 }), space, access },
  { additionalProperties: false },
);
export type PersonGrant = Static<typeof PersonGrant>;
export type PersonGrants = Record<string, PersonGrant>;
/** Tuple encoding avoids treating punctuation in a canonical profile ID as structure. */
export const personGrantKey = (requesterProfileId: string, agentId: string) =>
  JSON.stringify([requesterProfileId, agentId]);
export const PersonGrantsSnapshot = Type.Object(
  {
    revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    entries: Type.Array(PersonGrant, { maxItems: 500 }),
  },
  { additionalProperties: false },
);
export const PersonGrantChangeInput = Type.Object(
  {
    expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    profileId,
    agent,
    space,
    access: Type.Union([access, Type.Literal("none")]),
  },
  { additionalProperties: false },
);
export type PersonGrantChangeInput = Static<typeof PersonGrantChangeInput>;
