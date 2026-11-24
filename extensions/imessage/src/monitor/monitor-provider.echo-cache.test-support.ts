import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IMESSAGE_SENT_ECHOES_MAX_ENTRIES,
  IMESSAGE_SENT_ECHOES_NAMESPACE,
  IMESSAGE_SENT_ECHOES_TTL_MS,
  resolveIMessageSentEchoEntryKey,
} from "../state-contract.js";
import {
  createIMessagePluginStateSyncStoreForTest,
  installIMessageFailingStateRuntimeForTest,
  installIMessageStateRuntimeForTest,
} from "../test-support/runtime.js";
import { createSentMessageCache } from "./echo-cache.js";
import {
  hasPersistedIMessageEcho as hasEcho,
  rememberPersistedIMessageEcho as rememberEcho,
} from "./persisted-echo-cache.js";

const scope = "acct:imessage:+1555";
const media = { contentType: "image/png", kind: "image" } as const;

function timedCache() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
  return createSentMessageCache();
}

describe("iMessage sent-message echo cache", () => {
  beforeEach(() => {
    installIMessageStateRuntimeForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches recent text within the same scope", async () => {
    const cache = timedCache();

    cache.remember(scope, { text: "  Reasoning:\r\n_step_  " });

    expect(await cache.has(scope, { text: "Reasoning:\n_step_" })).toBe(true);
    expect(await cache.has("acct:imessage:+1666", { text: "Reasoning:\n_step_" })).toBe(false);
  });

  it.each(["\uFFFD\uFFFE\uFFFF\uFEFF", "\u0000\u0000"])(
    "matches delayed reflected echoes with leading corruption %j",
    async (markers) => {
      const cache = timedCache();
      cache.remember(scope, { text: "Delayed echo reply" });
      expect(await cache.has(scope, { text: markers + "Delayed echo reply" })).toBe(true);
    },
  );

  it.each([
    ["attributedBody", ["Delayed \uFFFD echo reply", "Delayed\techo reply", "Delayed\necho reply"]],
    ["NUL", ["Delayed\u0000echo reply"]],
  ] as const)("keeps %s corruption cleanup leading-only", async (_name, variants) => {
    const cache = timedCache();
    cache.remember(scope, { text: "Delayed echo reply" });
    for (const text of variants) {
      expect(await cache.has(scope, { text })).toBe(false);
    }
  });

  it("matches a delayed reflected echo with leading corruption markers via the persisted cache", async () => {
    const markers = String.fromCharCode(0x0000, 0xfffd, 0xfffe, 0xffff, 0xfeff);
    await rememberEcho({ scope, text: "Delayed echo reply" });

    expect(await hasEcho({ scope, text: "Delayed echo reply" })).toBe(true);
    expect(await hasEcho({ scope, text: `${markers}Delayed echo reply` })).toBe(true);
    expect(
      await hasEcho({
        scope,
        text: `Delayed${String.fromCharCode(0x0000)}echo reply`,
      }),
    ).toBe(false);
  });

  it("matches by outbound message id and ignores placeholder ids", async () => {
    const cache = timedCache();

    cache.remember(scope, { messageId: "abc-123" });
    cache.remember(scope, { messageId: "ok" });

    expect(await cache.has(scope, { messageId: "abc-123" })).toBe(true);
    expect(await cache.has(scope, { messageId: "ok" })).toBe(false);
  });

  it("keeps message-id lookups longer than text fallback", async () => {
    const cache = timedCache();

    cache.remember(scope, { text: "hello", messageId: "m-1" });
    vi.advanceTimersByTime(6_000);

    expect(await cache.has(scope, { text: "hello" })).toBe(false);
    expect(await cache.has(scope, { messageId: "m-1" })).toBe(true);
  });

  it("matches persisted echoes written before the monitor cache is created", async () => {
    await rememberEcho({ scope, text: "OpenClaw imsg live test", messageId: "guid-1" });
    const cache = createSentMessageCache();

    expect(await cache.has(scope, { text: "OpenClaw imsg live test" })).toBe(true);
    expect(await cache.has("acct:imessage:+1666", { text: "OpenClaw imsg live test" })).toBe(false);
    expect(await cache.has(scope, { messageId: "guid-1" })).toBe(true);
  });

  it("persists text-only and id-only echoes without undefined fields", async () => {
    await rememberEcho({ scope, text: "text-only" });
    await rememberEcho({ scope, messageId: "id-only" });

    const cache = createSentMessageCache();

    expect(await cache.has(scope, { text: "text-only" })).toBe(true);
    expect(await cache.has(scope, { messageId: "id-only" })).toBe(true);
  });

  it("does not match persisted media when both message ids differ", async () => {
    await rememberEcho({ scope, media, messageId: "guid-agent-image" });

    expect(await hasEcho({ scope, media, messageId: "guid-user-image" })).toBe(false);
    expect(
      await hasEcho({
        scope,
        media: { contentType: "image/jpeg", kind: "image" },
      }),
    ).toBe(true);
  });

  it("does not match persisted text when both message ids differ", async () => {
    await rememberEcho({ scope, text: "ok", messageId: "guid-agent-text" });

    expect(await hasEcho({ scope, text: "ok", messageId: "guid-user-text" })).toBe(false);
    expect(await hasEcho({ scope, text: "ok", messageId: "guid-agent-text" })).toBe(true);
    expect(await hasEcho({ scope, text: "ok" })).toBe(true);
  });

  it("matches persisted self-chat text after the in-memory cache expires", async () => {
    const cache = timedCache();
    const text = "Delayed self-chat echo";
    const outboundGuid = "p:0/guid-agent-text";

    await rememberEcho({ scope, text, messageId: outboundGuid });
    cache.remember(scope, { text, messageId: outboundGuid });
    vi.advanceTimersByTime(4_001);

    expect(await cache.has(scope, { text, messageId: "12345" }, { skipIdShortCircuit: true })).toBe(
      true,
    );
    expect(await cache.has(scope, { text, messageId: "p:0/guid-user-text" })).toBe(false);
  });

  it("matches persisted media through the primary sent-message cache", async () => {
    await rememberEcho({ scope, media, pending: true });

    const cache = createSentMessageCache();
    expect(await cache.has(scope, { media })).toBe(false);
    expect(await cache.has(scope, { media }, { includePendingText: true })).toBe(true);
  });

  it("does not use id-backed in-memory media after a different message id", async () => {
    const cache = timedCache();
    cache.remember(scope, { media, messageId: "guid-agent-image" });

    expect(
      await cache.has(scope, { media, messageId: "guid-user-image" }, { skipIdShortCircuit: true }),
    ).toBe(false);
    vi.advanceTimersByTime(1);
    cache.remember(scope, { media });
    expect(
      await cache.has(scope, { media, messageId: "guid-user-image" }, { skipIdShortCircuit: true }),
    ).toBe(true);
  });

  it("keeps short-lived pending persisted echoes out of generic text matching", async () => {
    timedCache();

    await rememberEcho({ scope, text: "pending-send", ttlMs: 1_000, pending: true });
    expect(await hasEcho({ scope, text: "pending-send" })).toBe(false);
    expect(await hasEcho({ scope, text: "pending-send", includePendingText: true })).toBe(true);

    vi.advanceTimersByTime(1_001);
    expect(await hasEcho({ scope, text: "pending-send", includePendingText: true })).toBe(false);
  });

  it("refreshes persisted echoes written after an earlier empty lookup", async () => {
    const cache = createSentMessageCache();
    expect(await cache.has(scope, { messageId: "guid-late" })).toBe(false);

    const entry = { scope, messageId: "guid-late", timestamp: Date.now() };
    createIMessagePluginStateSyncStoreForTest({
      namespace: IMESSAGE_SENT_ECHOES_NAMESPACE,
      maxEntries: IMESSAGE_SENT_ECHOES_MAX_ENTRIES,
    }).register(resolveIMessageSentEchoEntryKey(entry), entry, {
      ttlMs: IMESSAGE_SENT_ECHOES_TTL_MS,
    });

    expect(await cache.has(scope, { messageId: "guid-late" })).toBe(true);
  });

  it("does not match stale echoes after persisted read failure", async () => {
    timedCache();

    await rememberEcho({ scope, text: "stale echo" });
    expect(await hasEcho({ scope, text: "stale echo" })).toBe(true);

    vi.advanceTimersByTime(IMESSAGE_SENT_ECHOES_TTL_MS + 1);
    installIMessageFailingStateRuntimeForTest();

    expect(await hasEcho({ scope, text: "stale echo" })).toBe(false);
  });

  it("retains entries written hours earlier so a reconnect re-emit still sees own outbound rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
    await rememberEcho({
      scope,
      text: "agent reply from before the gap",
      messageId: "guid-pre-gap",
    });

    vi.setSystemTime(new Date("2026-05-08T15:00:00Z"));
    const cache = createSentMessageCache();
    expect(await cache.has(scope, { text: "agent reply from before the gap" })).toBe(true);
    expect(await cache.has(scope, { messageId: "guid-pre-gap" })).toBe(true);
  });
});
