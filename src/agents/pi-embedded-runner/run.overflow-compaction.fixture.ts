import type { EmbeddedRunAttemptResult } from "./run/types.js";

export function makeAttemptResult(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  return {
    aborted: false,
    timedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    sessionIdUsed: "test-session",
    assistantTexts: ["Hello!"],
    toolMetas: [],
    lastAssistant: undefined,
    messagesSnapshot: [],
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    ...overrides,
  };
}
