/** One normalized turn from the OpenClaw session transcript. */
export type NormalizedTurn = {
  /** Zero-based index in the full filtered turn list. */
  index: number;
  role: "user" | "assistant";
  text: string;
};

/** Per-session checkpoint stored in stateDir/{sessionId}.json */
export type SessionCheckpoint = {
  openclawSessionId: string;
  sessionKey: string;
  agentId: string;
  /** OpenViking session ID (null = not yet created). */
  ovSessionId: string | null;
  /** Index of the last successfully flushed turn (exclusive: next flush starts here). */
  lastFlushedIndex: number;
  /** True once the session has been committed to OV and is permanently closed. */
  finalized: boolean;
  updatedAt: string;
};
