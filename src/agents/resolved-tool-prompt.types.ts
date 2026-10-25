/** Caller-owned guidance finalized after the native runner selects its tools. */
export type ResolvedToolPromptFinalizer = (params: {
  prompt: string;
  messageToolAvailable: boolean;
}) => string;
