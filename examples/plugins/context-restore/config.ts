export const contextRestoreConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    anchorText: {
      type: "string",
      description:
        "Text appended to the system prompt on every turn. Keep it short and stable so Anthropic can cache it.",
    },
    restoreFiles: {
      type: "array",
      items: { type: "string" },
      description:
        'List of file paths (relative to the agent workspace) to re-read after compaction. Example: ["AGENTS.md", "SOUL.md", "SECURITY.md"]',
    },
    sessionPrefix: {
      type: "string",
      description:
        "Only apply to sessions whose key starts with this value. Leave empty (default) to apply to all sessions.",
    },
  },
};

export type ContextRestoreConfig = {
  anchorText?: string;
  restoreFiles?: string[];
  sessionPrefix?: string;
};
