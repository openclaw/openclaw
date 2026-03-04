import { afterEach, describe, expect, it } from "vitest";
import {
  BINDINGS_BY_BINDING_KEY,
  BINDINGS_BY_SESSION_KEY,
  normalizeTargetKind,
  normalizeThreadId,
  removeBindingRecord,
  resetSlackThreadBindingsForTests,
  resolveBindingIdsForSession,
  resolveBindingRecordKey,
  setBindingRecord,
  toBindingRecordKey,
} from "./thread-bindings.state.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

function makeRecord(overrides: Partial<ThreadBindingRecord> = {}): ThreadBindingRecord {
  return {
    accountId: "default",
    channelId: "C123",
    threadId: "1234567890.123456",
    targetKind: "acp",
    targetSessionKey: "agent:test-agent:acp:test-session",
    agentId: "test-agent",
    boundBy: "U999",
    boundAt: Date.now(),
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

describe("slack thread-bindings state", () => {
  afterEach(() => {
    resetSlackThreadBindingsForTests();
  });

  describe("toBindingRecordKey", () => {
    it("includes accountId, channelId, and threadId", () => {
      expect(
        toBindingRecordKey({
          accountId: "default",
          channelId: "C123",
          threadId: "1234567890.123456",
        }),
      ).toBe("default:C123:1234567890.123456");
    });
  });

  describe("resolveBindingRecordKey", () => {
    it("returns key for valid params", () => {
      expect(
        resolveBindingRecordKey({
          accountId: "default",
          channelId: "C123",
          threadId: "1234567890.123456",
        }),
      ).toBe("default:C123:1234567890.123456");
    });

    it("returns undefined for missing threadId", () => {
      expect(resolveBindingRecordKey({ channelId: "C123", threadId: "" })).toBeUndefined();
    });

    it("returns undefined for missing channelId", () => {
      expect(
        resolveBindingRecordKey({ channelId: "", threadId: "1234567890.123456" }),
      ).toBeUndefined();
    });
  });

  describe("normalizeThreadId", () => {
    it("trims strings", () => {
      expect(normalizeThreadId(" 1234567890.123456 ")).toBe("1234567890.123456");
    });

    it("returns undefined for non-strings", () => {
      expect(normalizeThreadId(123)).toBeUndefined();
      expect(normalizeThreadId(null)).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      expect(normalizeThreadId("")).toBeUndefined();
    });
  });

  describe("normalizeTargetKind", () => {
    it("returns acp for acp", () => {
      expect(normalizeTargetKind("acp", "agent:x:acp:y")).toBe("acp");
    });

    it("returns subagent for subagent", () => {
      expect(normalizeTargetKind("subagent", "agent:x:subagent:y")).toBe("subagent");
    });

    it("infers subagent from session key", () => {
      expect(normalizeTargetKind(undefined, "agent:x:subagent:y")).toBe("subagent");
    });

    it("defaults to acp", () => {
      expect(normalizeTargetKind(undefined, "agent:x:acp:y")).toBe("acp");
    });
  });

  describe("setBindingRecord / removeBindingRecord", () => {
    it("stores and removes binding", () => {
      const record = makeRecord();
      setBindingRecord(record);
      const key = toBindingRecordKey({
        accountId: record.accountId,
        channelId: record.channelId,
        threadId: record.threadId,
      });
      expect(BINDINGS_BY_BINDING_KEY.get(key)).toEqual(record);
      expect(BINDINGS_BY_SESSION_KEY.has(record.targetSessionKey)).toBe(true);

      const removed = removeBindingRecord(key);
      expect(removed).toEqual(record);
      expect(BINDINGS_BY_BINDING_KEY.has(key)).toBe(false);
      expect(BINDINGS_BY_SESSION_KEY.has(record.targetSessionKey)).toBe(false);
    });

    it("replaces existing binding and unlinks old session", () => {
      const record1 = makeRecord({ targetSessionKey: "session-1" });
      setBindingRecord(record1);
      const key = toBindingRecordKey({
        accountId: record1.accountId,
        channelId: record1.channelId,
        threadId: record1.threadId,
      });
      expect(BINDINGS_BY_SESSION_KEY.has("session-1")).toBe(true);

      const record2 = makeRecord({ targetSessionKey: "session-2" });
      setBindingRecord(record2);
      expect(BINDINGS_BY_BINDING_KEY.get(key)?.targetSessionKey).toBe("session-2");
      expect(BINDINGS_BY_SESSION_KEY.has("session-1")).toBe(false);
      expect(BINDINGS_BY_SESSION_KEY.has("session-2")).toBe(true);
    });
  });

  describe("resolveBindingIdsForSession", () => {
    it("returns binding ids for session key", () => {
      const record = makeRecord();
      setBindingRecord(record);
      const ids = resolveBindingIdsForSession({
        targetSessionKey: record.targetSessionKey,
      });
      expect(ids).toHaveLength(1);
    });

    it("filters by accountId", () => {
      const record = makeRecord({ accountId: "acct-1" });
      setBindingRecord(record);
      expect(
        resolveBindingIdsForSession({
          targetSessionKey: record.targetSessionKey,
          accountId: "acct-1",
        }),
      ).toHaveLength(1);
      expect(
        resolveBindingIdsForSession({
          targetSessionKey: record.targetSessionKey,
          accountId: "acct-2",
        }),
      ).toHaveLength(0);
    });
  });
});
