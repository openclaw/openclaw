import type { Static } from "typebox";
import { Type } from "typebox";
import { CHAT_INPUT_RUN_ID_MAX_CHARS } from "./chat-history-constants.js";
import { closedObject } from "./closed-object.js";
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "./primitives.js";
import { SessionRunStatusSchema } from "./sessions-row.js";

function boundedNonblankString(maxLength: number) {
  return Type.String({
    minLength: 1,
    maxLength,
    // TypeBox counts graphemes for maxLength; Unicode-mode pattern enforces
    // finite code-point bounds including trailing newlines.
    pattern: `^(?=[\\s\\S]{1,${maxLength}}(?![\\s\\S]))[\\s\\S]*\\S`,
  });
}

const SessionKey = boundedNonblankString(CHAT_SEND_SESSION_KEY_MAX_LENGTH);
const AgentId = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*(?![\\s\\S])",
});
const SessionId = boundedNonblankString(128);
const RunId = boundedNonblankString(CHAT_INPUT_RUN_ID_MAX_CHARS);
const Timestamp = Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

/** Reads one session; an exact terminal-run query also requires its session generation. */
export const SessionsStatusParamsSchema = Type.Object(
  {
    key: SessionKey,
    agentId: Type.Optional(AgentId),
    sessionId: Type.Optional(SessionId),
    expectedRunId: Type.Optional(RunId),
  },
  {
    additionalProperties: false,
    anyOf: [{ required: ["sessionId"] }, { not: { required: ["expectedRunId"] } }],
  },
);

/** Only the stored terminal fact may identify the selected public run. */
export const SessionStatusMatchedRunSchema = closedObject({
  runId: RunId,
  status: Type.Union([
    Type.Literal("done"),
    Type.Literal("failed"),
    Type.Literal("killed"),
    Type.Literal("timeout"),
  ]),
  endedAt: Type.Optional(Timestamp),
});

export const SessionStatusSchema = closedObject({
  key: SessionKey,
  agentId: AgentId,
  sessionId: SessionId,
  status: Type.Optional(SessionRunStatusSchema),
  hasActiveRun: Type.Boolean(),
  updatedAt: Type.Optional(Timestamp),
  matchedRun: Type.Union([SessionStatusMatchedRunSchema, Type.Null()]),
});

/** Observation time is not evidence of run progress and must not renew cached freshness. */
export const SessionsStatusResultSchema = closedObject({
  observedAt: Timestamp,
  session: Type.Union([SessionStatusSchema, Type.Null()]),
});

export type SessionsStatusParams = Static<typeof SessionsStatusParamsSchema>;
export type SessionStatusMatchedRun = Static<typeof SessionStatusMatchedRunSchema>;
export type SessionStatus = Static<typeof SessionStatusSchema>;
export type SessionsStatusResult = Static<typeof SessionsStatusResultSchema>;
