import { describe, expect, it } from "vitest";
import { resolveGoogleChatSessionKey } from "./monitor.js";

describe("resolveGoogleChatSessionKey", () => {
  const baseSessionKey = "agent:main:googlechat:group:spaces/aaaa";
  const threadA = "spaces/AAAA/threads/t-A";
  const threadB = "spaces/AAAA/threads/t-B";

  it("returns the base session key when sessionThread is disabled", () => {
    expect(
      resolveGoogleChatSessionKey({
        baseSessionKey,
        threadName: threadA,
        sessionThread: false,
      }),
    ).toBe(baseSessionKey);
  });

  it("returns the base session key when sessionThread is undefined (default)", () => {
    expect(
      resolveGoogleChatSessionKey({
        baseSessionKey,
        threadName: threadA,
        sessionThread: undefined,
      }),
    ).toBe(baseSessionKey);
  });

  it("appends a hashed :gcthread:<hash> suffix when sessionThread is enabled and inbound has a thread", () => {
    const key = resolveGoogleChatSessionKey({
      baseSessionKey,
      threadName: threadA,
      sessionThread: true,
    });
    expect(key.startsWith(`${baseSessionKey}:gcthread:`)).toBe(true);
    // Raw thread name bytes must not appear in the suffix; the case-sensitive
    // name flows through ctx.MessageThreadId, not the session key.
    expect(key).not.toContain(threadA);
    expect(key).not.toBe(baseSessionKey);
  });

  it("falls back to the base session key when sessionThread is enabled but inbound has no thread", () => {
    expect(
      resolveGoogleChatSessionKey({
        baseSessionKey,
        threadName: null,
        sessionThread: true,
      }),
    ).toBe(baseSessionKey);
    expect(
      resolveGoogleChatSessionKey({
        baseSessionKey,
        threadName: undefined,
        sessionThread: true,
      }),
    ).toBe(baseSessionKey);
  });

  it("produces distinct session keys for distinct threads so sessions don't cross", () => {
    const a = resolveGoogleChatSessionKey({
      baseSessionKey,
      threadName: threadA,
      sessionThread: true,
    });
    const b = resolveGoogleChatSessionKey({
      baseSessionKey,
      threadName: threadB,
      sessionThread: true,
    });
    expect(a).not.toBe(b);
  });

  it("is deterministic so the same thread resolves to the same session key across restarts", () => {
    const a = resolveGoogleChatSessionKey({
      baseSessionKey,
      threadName: threadA,
      sessionThread: true,
    });
    const b = resolveGoogleChatSessionKey({
      baseSessionKey,
      threadName: threadA,
      sessionThread: true,
    });
    expect(a).toBe(b);
  });

  it("survives store canonicalization (lowercasing) so later key lookups still match", () => {
    const key = resolveGoogleChatSessionKey({
      baseSessionKey,
      threadName: "spaces/AaAa/threads/MixedCaseID",
      sessionThread: true,
    });
    // Hash is hex → lowercasing is a no-op on the suffix content.
    expect(key).toBe(key.toLowerCase());
  });

  it("avoids the generic :thread: marker so parseSessionThreadInfo does not surface the hash as a routable thread id", () => {
    const key = resolveGoogleChatSessionKey({
      baseSessionKey,
      threadName: threadA,
      sessionThread: true,
    });
    expect(key).not.toContain(":thread:");
  });
});
