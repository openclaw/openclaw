import type { Static } from "typebox";
import type { SchemaContract } from "./schema-contract.js";
import type { SessionCommunicationPolicySchema } from "./schema/sessions-communication.js";

/** Human-selected policy for initiating messages between sessions. */
export const SESSION_COMMUNICATION_MODES = ["always", "ask", "never"] as const;
export type SessionCommunicationMode = (typeof SESSION_COMMUNICATION_MODES)[number];

/** Omitted directions follow the configured default, not a saved copy of it. */
export type SessionCommunicationPolicy = SchemaContract<
  Static<typeof SessionCommunicationPolicySchema>
>;

export type EffectiveSessionCommunicationPolicy = Required<SessionCommunicationPolicy>;
