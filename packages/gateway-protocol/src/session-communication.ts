/** Human-selected policy for initiating messages between sessions. */
export const SESSION_COMMUNICATION_MODES = ["always", "ask", "never"] as const;
export type SessionCommunicationMode = (typeof SESSION_COMMUNICATION_MODES)[number];

/** Omitted directions follow the configured default, not a saved copy of it. */
export type SessionCommunicationPolicy = {
  send?: SessionCommunicationMode;
  receive?: SessionCommunicationMode;
};

export type EffectiveSessionCommunicationPolicy = Required<SessionCommunicationPolicy>;
