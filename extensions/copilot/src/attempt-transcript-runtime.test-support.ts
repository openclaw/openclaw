import { vi } from "vitest";

// attempt.test.ts imports this module before ./attempt.js, so the mock is registered before the
// attempt runtime first loads the session transcript runtime.
type TranscriptAppendParams = Parameters<
  typeof import("openclaw/plugin-sdk/session-transcript-runtime").appendSessionTranscriptMessageByIdentityStrict
>[0];

const transcriptRuntime = vi.hoisted(() => ({
  append: vi.fn(appendPreparedTranscriptMessage),
  appendBatch: vi.fn(async (params: { messages: Array<Record<string, unknown>> }) =>
    params.messages.map((message) => ({
      appended: true,
      message: message.message,
      messageId: (message.eventId as string | undefined) ?? "transcript-message",
    })),
  ),
  publish: vi.fn(async () => undefined),
  appendStrict: vi.fn(async (params: TranscriptAppendParams) => {
    const result = await transcriptRuntime.append(params);
    return result ? { kind: "result" as const, result } : { kind: "suppressed" as const };
  }),
  readVisible: vi.fn(async () => []),
  // Appends are mocked, so the transcript holds nothing a real read could find. Without this
  // mock, tool-group tests open a real agent database at the relative fixture storePath,
  // which lands openclaw-agent.sqlite in the checkout root.
  withWrite: vi.fn(async (_target: unknown, run: (context: never) => unknown) =>
    run({
      readMessageFacts: async () => ({
        anchorsByIdempotencyKey: new Map(),
        existingIdempotencyKeys: new Set<string>(),
        messagesByIdempotencyKey: new Map(),
      }),
    } as never),
  ),
}));

export const transcriptRuntimeMock = transcriptRuntime;

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>();
  return {
    ...actual,
    appendSessionTranscriptMessageByIdentity: transcriptRuntime.append,
    appendSessionTranscriptMessageByIdentityStrict: transcriptRuntime.appendStrict,
    appendSessionTranscriptMessagesByIdentity: transcriptRuntime.appendBatch,
    publishSessionTranscriptUpdateByIdentity: transcriptRuntime.publish,
    readVisibleSessionTranscriptMessageEntries: transcriptRuntime.readVisible,
    withSessionTranscriptWrite: transcriptRuntime.withWrite,
  };
});

export async function appendPreparedTranscriptMessage(params: TranscriptAppendParams) {
  const prepare = params.preparation?.prepareMessage;
  const message = prepare ? await prepare(params.message) : params.message;
  return message
    ? { appended: true, message, messageId: params.eventId ?? "transcript-message" }
    : undefined;
}
