import { describe, expect, it } from "vitest";
import {
  assertCodexThreadResumeResponse,
  assertCodexThreadStartResponse,
} from "./protocol-validators.js";

const THREAD_BASE = {
  id: "thread-1",
  sessionId: "session-1",
  forkedFromId: null,
  preview: "",
  ephemeral: false,
  modelProvider: "openai",
  createdAt: 1,
  updatedAt: 1,
  status: { type: "idle" },
  path: null,
  cwd: "/tmp/cwd",
  cliVersion: "0.125.0",
  source: "unknown",
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns: [],
};

const RESPONSE_BASE = {
  model: "gpt-5.4",
  modelProvider: "openai",
  cwd: "/tmp/cwd",
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandbox: { type: "dangerFullAccess" },
};

describe("assertCodexThreadStartResponse", () => {
  it("accepts a valid response with both id and sessionId", () => {
    const result = assertCodexThreadStartResponse({
      ...RESPONSE_BASE,
      thread: { ...THREAD_BASE },
    });
    expect(result.thread.id).toBe("thread-1");
    expect(result.thread.sessionId).toBe("session-1");
  });

  it("normalizes thread.sessionId from thread.id when sessionId is absent", () => {
    const { sessionId: _omit, ...threadWithoutSessionId } = THREAD_BASE;
    const result = assertCodexThreadStartResponse({
      ...RESPONSE_BASE,
      thread: threadWithoutSessionId,
    });
    expect(result.thread.sessionId).toBe("thread-1");
    expect(result.thread.id).toBe("thread-1");
  });

  it("normalizes thread.id from thread.sessionId when id is absent", () => {
    const { id: _omit, ...threadWithoutId } = THREAD_BASE;
    const result = assertCodexThreadStartResponse({
      ...RESPONSE_BASE,
      thread: threadWithoutId,
    });
    expect(result.thread.id).toBe("session-1");
    expect(result.thread.sessionId).toBe("session-1");
  });
});

describe("assertCodexThreadResumeResponse", () => {
  it("normalizes thread.sessionId from thread.id when sessionId is absent", () => {
    const { sessionId: _omit, ...threadWithoutSessionId } = THREAD_BASE;
    const result = assertCodexThreadResumeResponse({
      ...RESPONSE_BASE,
      thread: threadWithoutSessionId,
    });
    expect(result.thread.sessionId).toBe("thread-1");
  });
});
