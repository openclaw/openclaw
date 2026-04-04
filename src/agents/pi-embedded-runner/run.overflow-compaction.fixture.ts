import { buildAttemptReplayMetadata } from "./run/incomplete-turn.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

export const DEFAULT_OVERFLOW_ERROR_MESSAGE =
  "request_too_large: Request size exceeds model context window";

export function makeOverflowError(message: string = DEFAULT_OVERFLOW_ERROR_MESSAGE): Error {
  return new Error(message);
}

export function makeCompactionSuccess(params: {
  summary: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  tokensAfter?: number;
}) {
  return {
    ok: true as const,
    compacted: true as const,
    result: {
      summary: params.summary,
      ...(params.firstKeptEntryId ? { firstKeptEntryId: params.firstKeptEntryId } : {}),
      ...(params.tokensBefore !== undefined ? { tokensBefore: params.tokensBefore } : {}),
      ...(params.tokensAfter !== undefined ? { tokensAfter: params.tokensAfter } : {}),
    },
  };
}

export function makeAttemptResult(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  const toolMetas = overrides.toolMetas ?? [];
  const didSendViaMessagingTool = overrides.didSendViaMessagingTool ?? false;
  const successfulCronAdds = overrides.successfulCronAdds;
  return {
    aborted: false,
    timedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    sessionIdUsed: "test-session",
    assistantTexts: ["Hello!"],
    toolMetas,
    lastAssistant: undefined,
    messagesSnapshot: [],
    replayMetadata:
      overrides.replayMetadata ??
      buildAttemptReplayMetadata({
        toolMetas,
        didSendViaMessagingTool,
        successfulCronAdds,
      }),
    didSendViaMessagingTool,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    ...overrides,
  };
}

type MockRunEmbeddedAttempt = {
  mockResolvedValueOnce: (value: EmbeddedRunAttemptResult) => unknown;
};

type MockCompactDirect = {
  mockResolvedValueOnce: (value: {
    ok: true;
    compacted: true;
    result: {
      summary: string;
      firstKeptEntryId?: string;
      tokensBefore?: number;
      tokensAfter?: number;
    };
  }) => unknown;
};

export function mockOverflowRetrySuccess(params: {
  runEmbeddedAttempt: MockRunEmbeddedAttempt;
  compactDirect: MockCompactDirect;
  overflowMessage?: string;
}) {
  const overflowError = makeOverflowError(params.overflowMessage);

  params.runEmbeddedAttempt.mockResolvedValueOnce(
    makeAttemptResult({ promptError: overflowError }),
  );
  params.runEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

  params.compactDirect.mockResolvedValueOnce(
    makeCompactionSuccess({
      summary: "Compacted session",
      firstKeptEntryId: "entry-5",
      tokensBefore: 150000,
    }),
  );

  return overflowError;
}

export function queueOverflowAttemptWithOversizedToolOutput(
  runEmbeddedAttempt: MockRunEmbeddedAttempt,
  overflowError: Error = makeOverflowError(),
): Error {
  runEmbeddedAttempt.mockResolvedValueOnce(
    makeAttemptResult({
      promptError: overflowError,
      messagesSnapshot: [
        {
          role: "assistant",
          content: "big tool output",
        } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
      ],
    }),
  );
  return overflowError;
}
