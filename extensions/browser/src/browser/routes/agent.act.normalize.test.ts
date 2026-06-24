// Browser tests cover agent.act.normalize plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveTargetIdFromTabs } from "../target-id.js";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "../timer-delay.js";
import { canonicalizeActTargetIds, normalizeActRequest } from "./agent.act.normalize.js";

describe("canonicalizeActTargetIds", () => {
  // Mirrors the route: the request tab carries every alias form, and the
  // predicate resolves an id against just that resolved tab.
  const canonical = "abcd1234";
  const tab = { targetId: canonical, suggestedTargetId: "sg-1", tabId: "tab-7", label: "Inbox" };
  const referencesTab = (raw: string) => resolveTargetIdFromTabs(raw, [tab]).ok;
  const run = (action: Parameters<typeof canonicalizeActTargetIds>[0]) =>
    canonicalizeActTargetIds(action, canonical, referencesTab);

  it("rewrites every same-tab alias to the canonical targetId before dispatch", () => {
    for (const alias of ["abcd", "tab-7", "Inbox", "sg-1", canonical]) {
      const result = run({ kind: "click", ref: "1", targetId: alias });
      expect(result.ok).toBe(true);
      // Canonical id is required: the Playwright executor reads
      // `action.targetId ?? targetId` for an exact page lookup, so a surviving
      // alias (prefix/tabId/label/suggested) would miss it at runtime.
      expect(result.ok && result.action.targetId).toBe(canonical);
    }
  });

  it("canonicalizes batch sub-action aliases recursively", () => {
    const result = run({
      kind: "batch",
      targetId: "abcd",
      actions: [
        { kind: "click", ref: "1", targetId: "tab-7" },
        { kind: "batch", actions: [{ kind: "resize", width: 2, height: 2, targetId: "Inbox" }] },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.action.kind !== "batch") throw new Error("expected batch");
    expect(result.action.targetId).toBe(canonical);
    const [first, nested] = result.action.actions;
    expect(first?.targetId).toBe(canonical);
    if (nested?.kind !== "batch") throw new Error("expected nested batch");
    expect(nested.actions[0]?.targetId).toBe(canonical);
  });

  it("leaves an absent targetId unset so dispatch falls back to the request tab", () => {
    const result = run({ kind: "click", ref: "1" });
    expect(result.ok && result.action.targetId).toBeUndefined();
  });

  it("rejects ids that resolve to a different tab", () => {
    expect(run({ kind: "click", ref: "1", targetId: "zzzz9999" })).toEqual({
      ok: false,
      error: "action targetId must match request targetId",
    });
    expect(
      run({ kind: "batch", actions: [{ kind: "click", ref: "1", targetId: "zzzz9999" }] }),
    ).toEqual({ ok: false, error: "batched action targetId must match request targetId" });
  });
});

describe("normalizeActRequest numeric fields", () => {
  it("keeps structured numeric action options", () => {
    expect(
      normalizeActRequest({
        kind: "click",
        ref: "button-1",
        delayMs: 25,
        timeoutMs: 5000,
      }),
    ).toMatchObject({
      kind: "click",
      ref: "button-1",
      delayMs: 25,
      timeoutMs: 5000,
    });
  });

  it("parses decimal integer strings for action options", () => {
    expect(
      normalizeActRequest({
        kind: "wait",
        timeMs: "25",
        timeoutMs: "5000",
      }),
    ).toMatchObject({
      kind: "wait",
      timeMs: 25,
      timeoutMs: 5000,
    });
  });

  it("caps oversized action timeouts", () => {
    expect(
      normalizeActRequest({
        kind: "wait",
        text: "ready",
        timeoutMs: String(Number.MAX_SAFE_INTEGER),
      }),
    ).toMatchObject({
      kind: "wait",
      text: "ready",
      timeoutMs: MAX_SAFE_TIMEOUT_DELAY_MS,
    });
  });

  it("rejects loose integer tokens for action durations and timeouts", () => {
    expect(() =>
      normalizeActRequest({
        kind: "click",
        ref: "button-1",
        delayMs: "0x10",
      }),
    ).toThrow("delayMs must be a non-negative integer.");

    expect(() =>
      normalizeActRequest({
        kind: "wait",
        timeMs: "1e3",
      }),
    ).toThrow("timeMs must be a non-negative integer.");

    expect(() =>
      normalizeActRequest({
        kind: "hover",
        ref: "button-1",
        timeoutMs: "1000ms",
      }),
    ).toThrow("timeoutMs must be a positive integer.");
  });

  it("rejects fractional viewport dimensions before dispatch", () => {
    expect(() =>
      normalizeActRequest({
        kind: "resize",
        width: "800.5",
        height: 600,
      }),
    ).toThrow("resize requires positive width and height");
  });
});
