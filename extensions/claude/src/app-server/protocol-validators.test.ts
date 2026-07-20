import { describe, expect, it } from "vitest";
import {
  ClaudeAppServerProtocolError,
  assertThreadResumeResponse,
  assertThreadStartResponse,
  assertTurnStartParams,
  assertTurnStartResponse,
  readDynamicToolCallParams,
  readErrorNotification,
  readTurn,
  readTurnCompletedNotification,
} from "./protocol-validators.js";

// ── assert helpers: throw on bad input ──────────────────────────────────────

describe("assertThreadStartResponse", () => {
  it("accepts a valid response with minimal required fields", () => {
    const response = assertThreadStartResponse({
      thread: { id: "thr_abc", sessionId: "s_1", cwd: "/tmp/ws" },
      model: "claude-sonnet-4-6",
      modelProvider: "anthropic",
      cwd: "/tmp/ws",
    });
    expect(response.thread.id).toBe("thr_abc");
    expect(response.model).toBe("claude-sonnet-4-6");
  });

  it("preserves extra fields via passthrough (forward-compat)", () => {
    const response = assertThreadStartResponse({
      thread: { id: "thr_abc", newServerOnlyField: { nested: true } },
      futureTopLevelField: "ok",
    } as unknown);
    expect((response.thread as Record<string, unknown>).newServerOnlyField).toBeDefined();
    expect((response as Record<string, unknown>).futureTopLevelField).toBe("ok");
  });

  it("throws ClaudeAppServerProtocolError with target name on missing thread.id", () => {
    expect.assertions(3);
    try {
      assertThreadStartResponse({ thread: {} });
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeAppServerProtocolError);
      const e = err as ClaudeAppServerProtocolError;
      expect(e.target).toBe("thread/start");
      expect(e.message).toContain("thread.id");
    }
  });

  it("throws on empty thread.id", () => {
    expect(() => assertThreadStartResponse({ thread: { id: "" } })).toThrow(
      ClaudeAppServerProtocolError,
    );
  });

  it("throws when thread field is missing entirely", () => {
    expect(() => assertThreadStartResponse({ model: "claude-sonnet-4-6" })).toThrow(
      ClaudeAppServerProtocolError,
    );
  });
});

describe("assertThreadResumeResponse", () => {
  it("validates against the same shape as thread/start", () => {
    const response = assertThreadResumeResponse({
      thread: { id: "thr_resume" },
    });
    expect(response.thread.id).toBe("thr_resume");
  });

  it("tags the error target as thread/resume", () => {
    try {
      assertThreadResumeResponse({ thread: {} });
    } catch (err) {
      expect((err as ClaudeAppServerProtocolError).target).toBe("thread/resume");
    }
  });
});

describe("assertTurnStartResponse", () => {
  it("accepts a turn with completed status", () => {
    const result = assertTurnStartResponse({
      turn: { id: "turn_1", threadId: "thr_a", status: "completed", items: [] },
    });
    expect(result.turn.id).toBe("turn_1");
    expect(result.turn.status).toBe("completed");
  });

  it("rejects an unknown status enum value", () => {
    expect(() => assertTurnStartResponse({ turn: { id: "turn_1", status: "weird" } })).toThrow(
      ClaudeAppServerProtocolError,
    );
  });

  it("accepts a turn with a nullable error object", () => {
    const result = assertTurnStartResponse({
      turn: { id: "t", status: "failed", error: { message: "boom" } },
    });
    expect(result.turn.error).toEqual({ message: "boom" });
  });

  it("accepts a turn with error: null (success path)", () => {
    const result = assertTurnStartResponse({
      turn: { id: "t", status: "completed", error: null },
    });
    expect(result.turn.error).toBeNull();
  });

  // Tank P1 regression: malformed turn/start responses must fail closed.
  // Without the assert helper, the runner reads response.turn.id off a
  // cast and propagates undefined as the turnId — which then poisons the
  // turnIdentity filter so the tool-call handler claims unrelated requests
  // from concurrent turns.
  it("fails closed when turn.id is empty", () => {
    expect(() => assertTurnStartResponse({ turn: { id: "", status: "inProgress" } })).toThrow(
      ClaudeAppServerProtocolError,
    );
  });

  it("fails closed when turn is missing entirely", () => {
    expect(() => assertTurnStartResponse({})).toThrow(ClaudeAppServerProtocolError);
  });
});

describe("assertTurnStartParams", () => {
  it("validates outbound turn/start params shape", () => {
    const params = assertTurnStartParams({
      threadId: "thr_a",
      input: [{ type: "text", text: "hi" }],
    });
    expect(params.threadId).toBe("thr_a");
  });

  it("rejects empty threadId", () => {
    expect(() => assertTurnStartParams({ threadId: "", input: [] })).toThrow(
      ClaudeAppServerProtocolError,
    );
  });

  it("rejects unknown effort enum", () => {
    expect(() => assertTurnStartParams({ threadId: "x", input: [], effort: "monstrous" })).toThrow(
      ClaudeAppServerProtocolError,
    );
  });
});

// ── read helpers: return undefined on bad input ─────────────────────────────

describe("readDynamicToolCallParams", () => {
  it("returns parsed params on valid shape", () => {
    const out = readDynamicToolCallParams({
      callId: "c1",
      threadId: "thr",
      turnId: "turn_a",
      tool: "image",
      arguments: { url: "https://example.com" },
    });
    expect(out?.callId).toBe("c1");
    expect(out?.tool).toBe("image");
  });

  it("returns undefined when callId is missing", () => {
    expect(readDynamicToolCallParams({ threadId: "thr", turnId: "t", tool: "x" })).toBeUndefined();
  });

  it("returns undefined when threadId is empty", () => {
    expect(
      readDynamicToolCallParams({ callId: "c", threadId: "", turnId: "t", tool: "x" }),
    ).toBeUndefined();
  });

  // Tank P1 regression: malformed item/tool/call params must NOT claim
  // unrelated requests. readDynamicToolCallParams returning undefined is
  // what makes the registerToolCallHandler `if (!call) return undefined`
  // guard work — it lets the handler chain try the next consumer instead
  // of dead-ending the request.
  it("fails closed on missing tool name (handler will skip)", () => {
    expect(
      readDynamicToolCallParams({ callId: "c", threadId: "thr", turnId: "t" }),
    ).toBeUndefined();
  });

  it("fails closed on missing turnId (cross-turn claim prevention)", () => {
    expect(readDynamicToolCallParams({ callId: "c", threadId: "thr", tool: "x" })).toBeUndefined();
  });

  it("returns undefined for non-objects", () => {
    expect(readDynamicToolCallParams(null)).toBeUndefined();
    expect(readDynamicToolCallParams("oops")).toBeUndefined();
  });
});

describe("readTurnCompletedNotification", () => {
  it("parses a valid notification", () => {
    const out = readTurnCompletedNotification({
      turn: { id: "t", status: "completed" },
    });
    expect(out?.turn.id).toBe("t");
  });

  it("returns undefined when turn.id missing", () => {
    expect(readTurnCompletedNotification({ turn: { status: "completed" } })).toBeUndefined();
  });
});

describe("readErrorNotification", () => {
  it("parses message-only error notifications", () => {
    expect(readErrorNotification({ message: "boom" })).toEqual({ message: "boom" });
  });

  it("preserves a string-typed code", () => {
    expect(readErrorNotification({ message: "rate_limit", code: "RATE_LIMITED" })).toEqual({
      message: "rate_limit",
      code: "RATE_LIMITED",
    });
  });

  it("preserves a numeric code", () => {
    expect(readErrorNotification({ message: "429", code: 429 })).toEqual({
      message: "429",
      code: 429,
    });
  });

  it("returns undefined when message missing", () => {
    expect(readErrorNotification({ code: 500 })).toBeUndefined();
  });
});

describe("readTurn", () => {
  it("returns a Turn for valid input", () => {
    expect(readTurn({ id: "t", status: "completed" })?.id).toBe("t");
  });

  it("returns undefined for malformed input", () => {
    expect(readTurn({ id: "t", status: "made-up" })).toBeUndefined();
  });
});
