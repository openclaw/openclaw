// Imessage test support covers monitor provider.echo cache plugin behavior.
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
import { hasPersistedIMessageEcho, rememberPersistedIMessageEcho } from "./persisted-echo-cache.js";

describe("iMessage sent-message echo cache", () => {
  beforeEach(async () => {
    await installIMessageStateRuntimeForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches recent text within the same scope", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "  Reasoning:\r\n_step_  " });

    expect(await cache.has("acct:imessage:+1555", { text: "Reasoning:\n_step_" })).toBe(true);
    expect(await cache.has("acct:imessage:+1666", { text: "Reasoning:\n_step_" })).toBe(false);
  });

  it("matches delayed reflected echoes with leading attributedBody corruption markers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "Delayed echo reply" });

    expect(
      await cache.has("acct:imessage:+1555", {
        text: "\uFFFD\uFFFE\uFFFF\uFEFFDelayed echo reply",
      }),
    ).toBe(true);
  });

  it("matches delayed reflected echoes with leading NUL corruption markers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "Delayed echo reply" });

    expect(
      await cache.has("acct:imessage:+1555", {
        text: "\u0000\u0000Delayed echo reply",
      }),
    ).toBe(true);
  });

  it("keeps attributedBody corruption cleanup leading-only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "Delayed echo reply" });

    expect(
      await cache.has("acct:imessage:+1555", {
        text: "Delayed \uFFFD echo reply",
      }),
    ).toBe(false);
    expect(await cache.has("acct:imessage:+1555", { text: "Delayed\techo reply" })).toBe(false);
    expect(await cache.has("acct:imessage:+1555", { text: "Delayed\necho reply" })).toBe(false);
  });

  it("keeps NUL corruption cleanup leading-only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "Delayed echo reply" });

    expect(await cache.has("acct:imessage:+1555", { text: "Delayed\u0000echo reply" })).toBe(false);
  });

  it("matches a delayed reflected echo with leading corruption markers via the persisted cache", async () => {
    // The persisted 12h cache is the only matcher once the 4s in-memory text TTL expires, so it
    // must strip leading attributedBody corruption markers exactly like the in-memory key (#93511).
    const scope = "acct:imessage:+1555";
    const markers = String.fromCharCode(0x0000, 0xfffd, 0xfffe, 0xffff, 0xfeff);
    await rememberPersistedIMessageEcho({ scope, text: "Delayed echo reply" });

    expect(await hasPersistedIMessageEcho({ scope, text: "Delayed echo reply" })).toBe(true);
    expect(await hasPersistedIMessageEcho({ scope, text: `${markers}Delayed echo reply` })).toBe(
      true,
    );
    // Leading-only: a mid-string marker stays distinct.
    expect(
      await hasPersistedIMessageEcho({
        scope,
        text: `Delayed${String.fromCharCode(0x0000)}echo reply`,
      }),
    ).toBe(false);
  });

  it("matches by outbound message id and ignores placeholder ids", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { messageId: "abc-123" });
    cache.remember("acct:imessage:+1555", { messageId: "ok" });

    expect(await cache.has("acct:imessage:+1555", { messageId: "abc-123" })).toBe(true);
    expect(await cache.has("acct:imessage:+1555", { messageId: "ok" })).toBe(false);
  });

  it("keeps message-id lookups longer than text fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "hello", messageId: "m-1" });
    // Text fallback stays short to avoid suppressing legitimate repeated user text.
    vi.advanceTimersByTime(6_000);

    expect(await cache.has("acct:imessage:+1555", { text: "hello" })).toBe(false);
    expect(await cache.has("acct:imessage:+1555", { messageId: "m-1" })).toBe(true);
  });

  it("matches persisted echoes written before the monitor cache is created", async () => {
    await rememberPersistedIMessageEcho({
      scope: "acct:imessage:+1555",
      text: "OpenClaw imsg live test",
      messageId: "guid-1",
    });
    const cache = createSentMessageCache();

    expect(await cache.has("acct:imessage:+1555", { text: "OpenClaw imsg live test" })).toBe(true);
    expect(await cache.has("acct:imessage:+1666", { text: "OpenClaw imsg live test" })).toBe(false);
    expect(await cache.has("acct:imessage:+1555", { messageId: "guid-1" })).toBe(true);
  });

  it("persists text-only and id-only echoes without undefined fields", async () => {
    const scope = "acct:imessage:+1555";
    await rememberPersistedIMessageEcho({ scope, text: "text-only" });
    await rememberPersistedIMessageEcho({ scope, messageId: "id-only" });

    const cache = createSentMessageCache();

    expect(await cache.has(scope, { text: "text-only" })).toBe(true);
    expect(await cache.has(scope, { messageId: "id-only" })).toBe(true);
  });

  it("does not match persisted media when both message ids differ", async () => {
    const scope = "acct:imessage:+1555";
    const media = { contentType: "image/png", kind: "image" as const };
    await rememberPersistedIMessageEcho({ scope, media, messageId: "guid-agent-image" });

    expect(await hasPersistedIMessageEcho({ scope, media, messageId: "guid-user-image" })).toBe(
      false,
    );
    expect(
      await hasPersistedIMessageEcho({
        scope,
        media: { contentType: "image/jpeg", kind: "image" },
      }),
    ).toBe(true);
  });

  it("does not match persisted text when both message ids differ", async () => {
    // Outbound "ok" recorded with its GUID; a user later sends "ok" with a new
    // GUID. Same text, conflicting ids — a NEW message, not a reconnect echo.
    const scope = "acct:imessage:+1555";
    await rememberPersistedIMessageEcho({ scope, text: "ok", messageId: "guid-agent-text" });

    expect(await hasPersistedIMessageEcho({ scope, text: "ok", messageId: "guid-user-text" })).toBe(
      false,
    );
    // Genuine echo still matches by id, and id-less probes still match by text.
    expect(
      await hasPersistedIMessageEcho({ scope, text: "ok", messageId: "guid-agent-text" }),
    ).toBe(true);
    expect(await hasPersistedIMessageEcho({ scope, text: "ok" })).toBe(true);
  });

  it("matches persisted self-chat text after the in-memory cache expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const scope = "acct:imessage:+1555";
    const cache = createSentMessageCache();
    const text = "Delayed self-chat echo";
    const outboundGuid = "p:0/guid-agent-text";

    await rememberPersistedIMessageEcho({ scope, text, messageId: outboundGuid });
    cache.remember(scope, { text, messageId: outboundGuid });
    vi.advanceTimersByTime(4_001);

    expect(await cache.has(scope, { text, messageId: "12345" }, { skipIdShortCircuit: true })).toBe(
      true,
    );
    expect(await cache.has(scope, { text, messageId: "p:0/guid-user-text" })).toBe(false);
  });

  it("matches persisted media through the primary sent-message cache", async () => {
    const scope = "acct:imessage:+1555";
    const media = { contentType: "image/png", kind: "image" as const };
    await rememberPersistedIMessageEcho({ scope, media, pending: true });

    const cache = createSentMessageCache();
    expect(await cache.has(scope, { media })).toBe(false);
    expect(await cache.has(scope, { media }, { includePendingText: true })).toBe(true);
  });

  it("does not use id-backed in-memory media after a different message id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const scope = "acct:imessage:+1555";
    const media = { contentType: "image/png", kind: "image" as const };
    const cache = createSentMessageCache();
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const scope = "acct:imessage:+1555";

    await rememberPersistedIMessageEcho({
      scope,
      text: "pending-send",
      ttlMs: 1_000,
      pending: true,
    });
    expect(await hasPersistedIMessageEcho({ scope, text: "pending-send" })).toBe(false);
    expect(
      await hasPersistedIMessageEcho({ scope, text: "pending-send", includePendingText: true }),
    ).toBe(true);

    vi.advanceTimersByTime(1_001);
    expect(
      await hasPersistedIMessageEcho({ scope, text: "pending-send", includePendingText: true }),
    ).toBe(false);
  });

  it("refreshes persisted echoes written after an earlier empty lookup", async () => {
    const cache = createSentMessageCache();
    const scope = "acct:imessage:+1555";
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const scope = "acct:imessage:+1555";

    await rememberPersistedIMessageEcho({ scope, text: "stale echo" });
    expect(await hasPersistedIMessageEcho({ scope, text: "stale echo" })).toBe(true);

    vi.advanceTimersByTime(IMESSAGE_SENT_ECHOES_TTL_MS + 1);
    await installIMessageFailingStateRuntimeForTest();

    expect(await hasPersistedIMessageEcho({ scope, text: "stale echo" })).toBe(false);
  });

  it("retains entries written hours earlier so a reconnect re-emit still sees own outbound rows", async () => {
    // The persisted-echo TTL must outlive the inbound replay guard window so
    // an own-outbound row that imsg re-emits after a bridge reconnect is still
    // recognized as the agent's echo, not re-ingested as an external send.
    // Regression guard for the echo-cache retention window.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
    await rememberPersistedIMessageEcho({
      scope: "acct:imessage:+1555",
      text: "agent reply from before the gap",
      messageId: "guid-pre-gap",
    });

    // Advance 3 hours — past the legacy 2-min TTL but well within the 12 h
    // retention required by the maxAgeMinutes=720 clamp.
    vi.setSystemTime(new Date("2026-05-08T15:00:00Z"));
    const cache = createSentMessageCache();
    expect(
      await cache.has("acct:imessage:+1555", { text: "agent reply from before the gap" }),
    ).toBe(true);
    expect(await cache.has("acct:imessage:+1555", { messageId: "guid-pre-gap" })).toBe(true);
  });
});
