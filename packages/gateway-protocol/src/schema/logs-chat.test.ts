import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  ChatEventSchema,
  ChatHistoryCursorResultSchema,
  ChatHistoryParamsSchema,
  ChatStartupParamsSchema,
  ChatSendParamsSchema,
  ChatStatusEventSchema,
} from "./logs-chat.js";

const statusEvent = {
  runId: "run-1",
  sessionKey: "agent:main:main",
  seq: 1,
  state: "status",
  phase: "preparing_context",
} as const;

describe("ChatStartupParamsSchema", () => {
  it("accepts one canonical or short selector while history remains canonical", () => {
    const short = { shortId: "12345678", agentId: "main", slugHint: "selected-chat" };
    expect(Value.Check(ChatStartupParamsSchema, short)).toBe(true);
    expect(
      Value.Check(ChatStartupParamsSchema, { sessionKey: "agent:main:main", cursor: "cursor" }),
    ).toBe(true);
    expect(Value.Check(ChatHistoryParamsSchema, short)).toBe(false);
    for (const invalid of [
      { ...short, sessionKey: "agent:main:main" },
      { ...short, cursor: "cursor" },
      { shortId: "12345678" },
    ]) {
      expect(Value.Check(ChatStartupParamsSchema, invalid)).toBe(false);
    }
  });
});

describe("ChatHistoryCursorResultSchema", () => {
  const sessionInfo = { key: "agent:main:main" };

  it("accepts only the closed delta and reset outcomes", () => {
    const delta = {
      kind: "delta",
      messages: [],
      deltaCursor: "cursor-2",
      sessionInfo,
    };
    expect(Value.Check(ChatHistoryCursorResultSchema, delta)).toBe(true);
    expect(
      Value.Check(ChatHistoryCursorResultSchema, {
        ...delta,
        inFlightRun: { runId: "run-live", text: "still working" },
        inputReceipts: [{ runId: "retained-run", state: "pending" }],
        inputConsumptions: [{ runId: "consumed-run", consumedByEventId: "event-1" }],
      }),
    ).toBe(true);
    for (const status of [undefined, "running", "completed", "failed", "blocked", "skipped"]) {
      const activity = [
        { messageId: "quiet", items: [] },
        {
          messageId: "work",
          items: [
            {
              itemId: "tool:work",
              kind: "tool",
              phase: "end",
              title: "Read",
              ...(status ? { status } : {}),
            },
          ],
        },
      ];
      const response = { ...delta, activity };
      const serialized = JSON.stringify(response);
      const decoded = JSON.parse(serialized);
      expect(Value.Check(ChatHistoryCursorResultSchema, decoded)).toBe(true);
      expect(decoded).toEqual(response);
    }
    for (const activity of [
      [{ items: [] }],
      [
        {
          messageId: "work",
          items: [{ itemId: "work", kind: "tool", phase: "end", title: "Read", status: "unknown" }],
        },
      ],
      [{ messageId: "work", items: [], raw: "private" }],
    ]) {
      expect(Value.Check(ChatHistoryCursorResultSchema, { ...delta, activity })).toBe(false);
    }
    expect(Value.Check(ChatHistoryCursorResultSchema, { kind: "reset" })).toBe(true);
    expect(Value.Check(ChatHistoryCursorResultSchema, { ...delta, extra: true })).toBe(false);
    expect(Value.Check(ChatHistoryCursorResultSchema, { kind: "reset", messages: [] })).toBe(false);
  });
});

describe("ChatStatusEventSchema", () => {
  it("accepts closed startup phases through the chat event union", () => {
    expect(Value.Check(ChatStatusEventSchema, statusEvent)).toBe(true);
    expect(Value.Check(ChatEventSchema, statusEvent)).toBe(true);
  });

  it("accepts bounded retry details while preserving the required coarse phase", () => {
    const event = {
      runId: "run-1",
      sessionKey: "session-1",
      seq: 2,
      state: "status",
      phase: "starting_model",
    };
    const retry = { attempt: 2, maxAttempts: 10, reason: "rate_limit" };
    for (const maxAttempts of [2, 10]) {
      expect(Value.Check(ChatEventSchema, { ...event, retry: { ...retry, maxAttempts } })).toBe(
        true,
      );
    }
    for (const invalid of [
      { attempt: 0 },
      { attempt: 11 },
      { attempt: 1.5 },
      { maxAttempts: 0 },
      { maxAttempts: 2.5 },
      { maxAttempts: 11 },
      { reason: "unknown" },
      { errorBody: "provider data" },
    ]) {
      expect(Value.Check(ChatEventSchema, { ...event, retry: { ...retry, ...invalid } })).toBe(
        false,
      );
    }
    expect(Value.Check(ChatEventSchema, { ...event, phase: undefined, retry })).toBe(false);
  });
});

describe("ChatErrorEventSchema", () => {
  const event = { runId: "run-1", sessionKey: "agent:main:main", seq: 1, state: "error" };
  const detail = {
    provider: "openai",
    model: "gpt-5.6-luna",
    failoverReason: "server_error",
    providerRuntimeFailureKind: "timeout",
    providerErrorType: "server_error",
    httpStatus: 502,
    providerErrorMessagePreview: "Upstream unavailable",
  };

  it("round-trips optional closed provider error details", () => {
    for (const errorDetail of [
      undefined,
      {},
      ...Object.entries(detail).map(([key, value]) => ({ [key]: value })),
      detail,
    ]) {
      const serialized = JSON.stringify({ ...event, errorDetail });
      const wire = JSON.parse(serialized);
      expect(Value.Check(ChatEventSchema, wire)).toBe(true);
    }
    expect(
      Value.Check(ChatEventSchema, {
        ...event,
        errorDetail: { ...detail, rawErrorPreview: "raw" },
      }),
    ).toBe(false);
    expect(Value.Check(ChatEventSchema, { ...event, state: "final", errorDetail: detail })).toBe(
      false,
    );
  });
});

describe("ChatSendParamsSchema", () => {
  const send = {
    sessionKey: "agent:main:main",
    message: "hello",
    idempotencyKey: "run-1",
  };

  it("admits bounded plugin page details while keeping ambient context closed", () => {
    const context = {
      page: "plugin:example:sessions",
      detail: { board: "board-1", view: "stuck sessions" },
    };
    expect(Value.Check(ChatSendParamsSchema, { ...send, workContext: context })).toBe(true);
    expect(
      Value.Check(ChatSendParamsSchema, {
        ...send,
        workContext: { ...context, detail: { "line\nbreak": "reference" } },
      }),
    ).toBe(true);
    expect(
      Value.Check(ChatSendParamsSchema, {
        ...send,
        workContext: { ...context, detail: { ["x".repeat(32)]: "x".repeat(128) } },
      }),
    ).toBe(true);
    for (const detail of [
      null,
      [],
      { board: 42 },
      { board: { id: "nested" } },
      { "line\nbreak": { id: "nested" } },
      { "": "empty key" },
      { ["x".repeat(33)]: "long key" },
      { board: "x".repeat(129) },
      { a: "1", b: "2", c: "3", d: "4", e: "5" },
    ]) {
      expect(
        Value.Check(ChatSendParamsSchema, { ...send, workContext: { ...context, detail } }),
      ).toBe(false);
    }
    expect(
      Value.Check(ChatSendParamsSchema, {
        ...send,
        workContext: { ...context, permission: "admin" },
      }),
    ).toBe(false);
  });
});
