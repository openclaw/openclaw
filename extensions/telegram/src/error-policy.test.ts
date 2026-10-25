import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTelegramErrorScopeKey,
  resolveTelegramErrorPolicy,
  shouldSuppressTelegramError,
} from "./error-policy.js";

let scopeSequence = 0;
let accountId: string;

function suppress(errorMessage: string) {
  return shouldSuppressTelegramError({
    scopeKey: buildTelegramErrorScopeKey({ accountId, chatId: 42 }),
    cooldownMs: 1000,
    errorMessage,
  });
}

describe("telegram error policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    accountId = `work-${scopeSequence++}`;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves policy from the most specific config", () => {
    expect(
      resolveTelegramErrorPolicy({
        accountConfig: { errorPolicy: "once" },
        groupConfig: {},
        topicConfig: { errorPolicy: "silent" },
      }),
    ).toEqual({ policy: "silent", cooldownMs: 14_400_000 });
  });

  it("keeps cooldowns per error message within the same scope", () => {
    expect(suppress("A")).toBe(false);
    expect(suppress("B")).toBe(false);
    expect(suppress("A")).toBe(true);
  });

  it("prunes expired cooldowns within a single scope", () => {
    expect(suppress("A")).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(suppress("B")).toBe(false);
    expect(suppress("A")).toBe(false);
  });

  it("does not leak suppression across accounts or threads", () => {
    const workMain = buildTelegramErrorScopeKey({
      accountId,
      chatId: 42,
    });
    const personalMain = buildTelegramErrorScopeKey({
      accountId: "personal",
      chatId: 42,
    });
    const workTopic = buildTelegramErrorScopeKey({
      accountId,
      chatId: 42,
      threadSpec: { id: 9, scope: "forum" },
    });

    expect(
      shouldSuppressTelegramError({
        scopeKey: workMain,
        cooldownMs: 1000,
        errorMessage: "429",
      }),
    ).toBe(false);
    expect(
      shouldSuppressTelegramError({
        scopeKey: personalMain,
        cooldownMs: 1000,
        errorMessage: "429",
      }),
    ).toBe(false);
    expect(
      shouldSuppressTelegramError({
        scopeKey: workTopic,
        cooldownMs: 1000,
        errorMessage: "429",
      }),
    ).toBe(false);
  });

  it("keeps forum and direct-message topics with the same id in separate scopes", () => {
    const scope = (kind: "forum" | "direct-messages") =>
      buildTelegramErrorScopeKey({
        accountId,
        chatId: 42,
        threadSpec: { id: 9, scope: kind },
      });
    expect(scope("forum")).not.toBe(scope("direct-messages"));
  });
});
