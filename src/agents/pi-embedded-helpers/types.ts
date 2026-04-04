export type EmbeddedContextFile = {
  path: string;
  content: string;
  /**
   * Context provenance metadata.
   * When present, a `<!-- ctx:provenance ... -->` comment is prepended to the
   * content during system-prompt assembly so the agent can distinguish stale
   * injected context from freshly-read content.
   */
  provenance?: {
    /** Human-readable origin, e.g. "SOUL.md", "memory_search". */
    source: string;
    /** When this segment was injected: "session_start" or a turn identifier. */
    injectedAt: string;
    /** Whether the underlying source may change during the session. */
    volatile: boolean;
  };
};

export type FailoverReason =
  | "auth"
  | "auth_permanent"
  | "format"
  | "rate_limit"
  | "overloaded"
  | "billing"
  | "timeout"
  | "model_not_found"
  | "session_expired"
  | "unknown";
