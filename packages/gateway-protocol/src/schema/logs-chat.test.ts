import { it } from "vitest";
import * as S from "./logs-chat.js";
import { schemaValidation } from "./protocol-validation.test-support.js";

const startup = schemaValidation(S.ChatStartupParamsSchema);
const history = schemaValidation(S.ChatHistoryCursorResultSchema);
const chat = schemaValidation(S.ChatEventSchema);
const send = schemaValidation(S.ChatSendParamsSchema);
const statusEvent = {
  runId: "run-1",
  sessionKey: "agent:main:main",
  seq: 1,
  state: "status",
  phase: "preparing_context",
} as const;

it("ChatStartupParamsSchema: accepts one canonical or short selector while history remains canonical", () => {
  const short = { shortId: "12345678", agentId: "main", slugHint: "selected-chat" };
  const canonical = { sessionKey: "agent:main:main", cursor: "cursor" };
  startup.accepts(short, canonical, {
    ...canonical,
    knownState: { pendingInputs: "pending-revision", sessionInfo: "session-revision" },
  });
  schemaValidation(S.ChatHistoryParamsSchema).rejects(short);
  startup.rejects(
    { ...short, sessionKey: canonical.sessionKey },
    { ...short, cursor: "cursor" },
    { shortId: "12345678" },
    { sessionKey: canonical.sessionKey, knownState: { pendingInputs: "x".repeat(65) } },
  );
});

it("ChatHistoryCursorResultSchema: accepts only the closed delta and reset outcomes", () => {
  const delta = { kind: "delta", messages: [], deltaCursor: "cursor-2" };
  history.accepts(delta, {
    ...delta,
    sessionInfo: { key: "agent:main:main" },
    stateRevision: { pendingInputs: "pending-revision", sessionInfo: "session-revision" },
    inFlightRun: { runId: "run-live", text: "still working" },
    inputReceipts: [{ runId: "retained-run", state: "pending" }],
    inputConsumptions: [{ runId: "consumed-run", consumedByEventId: "event-1" }],
  });
  const item = { itemId: "tool:work", kind: "tool", phase: "end", title: "Read" };
  const statuses = ["running", "completed", "failed", "blocked", "skipped"];
  const items = [item, ...statuses.map((status) => Object.assign({}, item, { status }))];
  history.accepts({
    ...delta,
    activity: [
      { messageId: "quiet", items: [] },
      { messageId: "work", items },
    ],
  });
  history.rejects(
    ...[
      [{ items: [] }],
      [{ messageId: "work", items: [{ ...item, itemId: "work", status: "unknown" }] }],
      [{ messageId: "work", items: [], raw: "private" }],
    ].map((activity) => Object.assign({}, delta, { activity })),
    { ...delta, extra: true },
    { kind: "reset", messages: [] },
  );
  history.accepts({ kind: "reset" });
});

it("ChatStatusEventSchema: accepts optional local model wait reasons and rejects unsupported claims", () => {
  schemaValidation(S.ChatStatusEventSchema).accepts(statusEvent);
  chat.accepts(statusEvent);
  const event = { ...statusEvent, phase: "waiting_for_model" };
  chat.accepts(event, { ...event, waitReason: "response" }, { ...event, waitReason: "slot" });
  chat.rejects({ ...event, waitReason: "busy" });
});

it("ChatStatusEventSchema: accepts bounded retry details while preserving the required coarse phase", () => {
  const event = { ...statusEvent, sessionKey: "session-1", seq: 2, phase: "starting_model" };
  const retry = { attempt: 2, maxAttempts: 10, reason: "rate_limit" };
  const withRetry = (override: object) => ({ ...event, retry: { ...retry, ...override } });
  chat.accepts(
    ...["rate_limit", "overloaded", "server_error", "timeout", "output_limit"].map((reason) =>
      withRetry({ reason, retryAt: 1_800_000_000_000 }),
    ),
    ...[2, 10].map((maxAttempts) => withRetry({ maxAttempts })),
  );
  chat.rejects(
    ...[
      { attempt: 0 },
      { attempt: 11 },
      { attempt: 1.5 },
      { maxAttempts: 0 },
      { maxAttempts: 2.5 },
      { maxAttempts: 11 },
      { reason: "unknown" },
      { retryAt: -1 },
      { retryAt: Infinity },
      { errorBody: "provider data" },
    ].map(withRetry),
    { ...event, phase: undefined, retry },
  );
});

it("ChatErrorEventSchema: accepts optional closed provider error details", () => {
  const event = { runId: "run-1", sessionKey: "agent:main:main", seq: 1, state: "error" };
  const detail = {
    provider: "openai",
    model: "gpt-5.6-luna",
    failoverReason: "server_error",
    providerRuntimeFailureKind: "timeout",
    providerErrorCode: "server_error",
    providerErrorType: "server_error",
    httpStatus: 502,
    providerErrorMessagePreview: "Upstream unavailable",
  };
  chat.accepts(event, { ...event, errorDetail: {} }, { ...event, errorDetail: detail });
  chat.rejects(
    { ...event, errorDetail: { ...detail, rawErrorPreview: "raw" } },
    { ...event, state: "final", errorDetail: detail },
  );
});

it("ChatSendParamsSchema: admits bounded plugin page details while keeping ambient context closed", () => {
  const request = { sessionKey: "agent:main:main", message: "hello", idempotencyKey: "run-1" };
  const withContext = (override: object) => ({
    ...request,
    workContext: { page: "plugin:example:sessions", ...override },
  });
  send.accepts(
    withContext({ detail: { board: "board-1", view: "stuck sessions" } }),
    withContext({ detail: { "line\nbreak": "reference" } }),
    withContext({ detail: { ["x".repeat(32)]: "x".repeat(128) } }),
  );
  send.rejects(
    ...[
      null,
      [],
      { board: 42 },
      { board: { id: "nested" } },
      { "line\nbreak": { id: "nested" } },
      { "": "empty key" },
      { ["x".repeat(33)]: "long key" },
      { board: "x".repeat(129) },
      { a: "1", b: "2", c: "3", d: "4", e: "5" },
    ].map((detail) => withContext({ detail })),
    withContext({ permission: "admin" }),
  );
});
