import { afterEach, describe, expect, it } from "vitest";
import {
  BINDINGS_BY_KEY,
  BINDINGS_BY_SESSION,
  ensureBindingsLoaded,
  parseConversationId,
  removeBindingRecord,
  resetForTests,
  resolveBindingKeysForSession,
  setBindingRecord,
  toBindingKey,
  toConversationId,
} from "./thread-bindings.state.js";
import type { FeishuThreadBindingRecord } from "./thread-bindings.types.js";

function makeRecord(overrides: Partial<FeishuThreadBindingRecord> = {}): FeishuThreadBindingRecord {
  return {
    accountId: "default",
    chatId: "oc_chat1",
    rootId: "om_root1",
    targetKind: "acp",
    targetSessionKey: "agent:default:feishu:group:oc_chat1",
    agentId: "default",
    boundBy: "system",
    boundAt: Date.now(),
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

afterEach(() => {
  resetForTests();
});

describe("toBindingKey", () => {
  it("concatenates accountId:chatId:rootId", () => {
    expect(toBindingKey("acc1", "oc_chat", "om_msg")).toBe("acc1:oc_chat:om_msg");
  });
});

describe("toConversationId / parseConversationId", () => {
  it("round-trips chatId:rootId", () => {
    const convId = toConversationId("oc_chat1", "om_root1");
    expect(convId).toBe("oc_chat1:om_root1");
    const parsed = parseConversationId(convId);
    expect(parsed).toEqual({ chatId: "oc_chat1", rootId: "om_root1" });
  });

  it("returns null for invalid conversationId", () => {
    expect(parseConversationId("nocolon")).toBeNull();
    expect(parseConversationId(":trailing")).toBeNull();
    expect(parseConversationId("leading:")).toBeNull();
  });
});

describe("setBindingRecord / removeBindingRecord", () => {
  it("stores and retrieves a binding record", () => {
    const record = makeRecord();
    setBindingRecord(record);

    const key = toBindingKey(record.accountId, record.chatId, record.rootId);
    expect(BINDINGS_BY_KEY.get(key)).toEqual(record);
    expect(BINDINGS_BY_SESSION.get(record.targetSessionKey)?.has(key)).toBe(true);
  });

  it("removes a binding record and unlinks session", () => {
    const record = makeRecord();
    setBindingRecord(record);
    const key = toBindingKey(record.accountId, record.chatId, record.rootId);

    const removed = removeBindingRecord(key);
    expect(removed).toEqual(record);
    expect(BINDINGS_BY_KEY.has(key)).toBe(false);
    expect(BINDINGS_BY_SESSION.has(record.targetSessionKey)).toBe(false);
  });

  it("returns null when removing non-existent key", () => {
    expect(removeBindingRecord("nonexistent")).toBeNull();
  });

  it("updates session index when record is replaced", () => {
    const record1 = makeRecord({ targetSessionKey: "session-a" });
    setBindingRecord(record1);
    const key = toBindingKey(record1.accountId, record1.chatId, record1.rootId);

    const record2 = makeRecord({ targetSessionKey: "session-b" });
    setBindingRecord(record2);

    expect(BINDINGS_BY_SESSION.has("session-a")).toBe(false);
    expect(BINDINGS_BY_SESSION.get("session-b")?.has(key)).toBe(true);
  });
});

describe("resolveBindingKeysForSession", () => {
  it("returns all keys for a session", () => {
    const sessionKey = "agent:default:feishu:group:oc_chat1";
    setBindingRecord(makeRecord({ rootId: "om_r1", targetSessionKey: sessionKey }));
    setBindingRecord(makeRecord({ rootId: "om_r2", targetSessionKey: sessionKey }));
    setBindingRecord(makeRecord({ rootId: "om_r3", targetSessionKey: "other-session" }));

    const keys = resolveBindingKeysForSession({ targetSessionKey: sessionKey });
    expect(keys).toHaveLength(2);
  });

  it("filters by accountId when provided", () => {
    const sessionKey = "agent:default:feishu:group:oc_chat1";
    setBindingRecord(
      makeRecord({ accountId: "acc1", rootId: "om_r1", targetSessionKey: sessionKey }),
    );
    setBindingRecord(
      makeRecord({ accountId: "acc2", rootId: "om_r2", targetSessionKey: sessionKey }),
    );

    const keys = resolveBindingKeysForSession({ targetSessionKey: sessionKey, accountId: "acc1" });
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("acc1:");
  });
});

describe("ensureBindingsLoaded", () => {
  it("is idempotent", () => {
    ensureBindingsLoaded();
    setBindingRecord(makeRecord());
    ensureBindingsLoaded(); // should not clear the record
    expect(BINDINGS_BY_KEY.size).toBe(1);
  });
});
