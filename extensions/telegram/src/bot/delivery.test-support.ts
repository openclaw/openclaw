import { createTelegramPromptContextProjectionSequence } from "../prompt-context-projection.js";

export function createObservedPromptContextSequence(
  record: (value: unknown) => void,
  source?: { transcriptMessageId: string },
) {
  return createTelegramPromptContextProjectionSequence({
    ...(source ? { source } : {}),
    record: async (value) => {
      record(value);
      return true;
    },
  });
}
