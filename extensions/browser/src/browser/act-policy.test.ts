import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import { resolveBrowserActRequestTimeoutMs } from "./act-policy.js";
import type { BrowserActRequest } from "./client-actions.types.js";

describe("browser action request deadlines", () => {
  it("sums the delay and every sequential wait condition", () => {
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "wait",
        timeMs: 10_000,
        text: "ready",
        textGone: "loading",
        selector: "#result",
        url: "**/done",
        loadState: "networkidle",
        fn: "() => true",
        timeoutMs: 20_000,
      }),
    ).toBe(135_000);
  });

  it("normalizes each condition timeout before multiplication", () => {
    const wait = {
      kind: "wait",
      text: "ready",
      textGone: "loading",
      selector: "#result",
      url: "**/done",
      loadState: "networkidle",
      fn: "() => true",
    } as const;

    expect(resolveBrowserActRequestTimeoutMs({ ...wait, timeoutMs: 1 })).toBe(8_000);
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "batch",
        actions: [{ ...wait, timeoutMs: Number.MAX_VALUE }],
      }),
    ).toBe(725_000);
  });

  it("keeps Playwright text whitespace in sequential batch budgets", () => {
    const wait = {
      kind: "wait",
      timeMs: 0,
      text: " ",
      textGone: " ",
      selector: "",
      url: " ",
      fn: " ",
    } as const;
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "batch",
        actions: [wait, wait],
      }),
    ).toBe(85_000);
  });

  it("recursively sums nested batch children in execution order", () => {
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "batch",
        actions: [
          { kind: "wait", timeMs: 30_000 },
          {
            kind: "batch",
            actions: [
              { kind: "wait", timeMs: 30_000 },
              { kind: "wait", timeMs: 30_000 },
            ],
          },
        ],
      }),
    ).toBe(95_000);
  });

  it("budgets action and verification defaults and adds outer slack once", () => {
    expect(resolveBrowserActRequestTimeoutMs({ kind: "click", ref: "1" })).toBe(126_250);
    expect(resolveBrowserActRequestTimeoutMs({ kind: "wait", timeMs: 0 })).toBe(126_250);
    expect(resolveBrowserActRequestTimeoutMs({ kind: "click", ref: "1", timeoutMs: 45_000 })).toBe(
      96_250,
    );
  });

  it("budgets sequential leaf phases and bounded delays", () => {
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "batch",
        actions: [
          {
            kind: "fill",
            fields: [
              { ref: "first", type: "text" },
              { ref: "second", type: "text" },
            ],
            timeoutMs: 40_000,
          },
        ],
      }),
    ).toBe(85_500);
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "type",
        ref: "field",
        text: "value",
        slowly: true,
        submit: true,
        timeoutMs: 60_000,
      }),
    ).toBe(185_250);
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "click",
        ref: "button",
        delayMs: 5_000,
        timeoutMs: 20_000,
      }),
    ).toBe(50_250);
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "clickCoords",
        x: 10,
        y: 20,
        doubleClick: true,
        delayMs: 5_000,
        timeoutMs: 1_000,
      }),
    ).toBe(21_250);
  });

  it.each([
    { kind: "type", ref: "field", text: "value" },
    { kind: "hover", ref: "field" },
    { kind: "scrollIntoView", ref: "field" },
    { kind: "drag", startRef: "first", endRef: "second" },
    { kind: "select", ref: "field", values: ["value"] },
    { kind: "fill", fields: [{ ref: "field", type: "text" }] },
  ] satisfies BrowserActRequest[])(
    "bounds $kind transport when only Playwright accepts the timeout override",
    (request) => {
      expect(
        resolveBrowserActRequestTimeoutMs({ ...request, timeoutMs: Number.MAX_VALUE }),
      ).toBeLessThanOrEqual(126_250);
    },
  );

  it("preserves the prior whole-request floor for batches", () => {
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "batch",
        actions: [
          {
            kind: "fill",
            fields: [
              { ref: "first", type: "text" },
              { ref: "second", type: "text" },
            ],
            timeoutMs: 20_000,
          },
        ],
      }),
    ).toBe(65_000);
  });

  it("budgets the wider scrollIntoView locator timeout", () => {
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "batch",
        actions: Array.from({ length: 4 }, () => ({
          kind: "scrollIntoView" as const,
          ref: "result",
        })),
      }),
    ).toBe(86_000);
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "batch",
        actions: [{ kind: "scrollIntoView", ref: "result", timeoutMs: 120_000 }],
      }),
    ).toBe(125_250);
  });

  it("leaves malformed model batch validation to the browser route", () => {
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "batch",
        requests: [],
        actions: [{ kind: "wait", selector: 1 }, { kind: "unknown" }, null],
      } as unknown as BrowserActRequest),
    ).toBe(65_000);
  });

  it("saturates aggregate and slack arithmetic at the timer limit", () => {
    const actions: BrowserActRequest[] = Array.from({ length: 3_000 }, () => ({
      kind: "wait",
      text: "ready",
      textGone: "loading",
      selector: "#result",
      url: "**/done",
      loadState: "load",
      fn: "() => true",
      timeoutMs: 120_000,
    }));
    const batch = { kind: "batch", actions } as const;

    expect(resolveBrowserActRequestTimeoutMs(batch)).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
