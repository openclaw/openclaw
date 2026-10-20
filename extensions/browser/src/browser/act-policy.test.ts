import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import { resolveBrowserActRequestTimeoutMs } from "./act-policy.js";
import type { BrowserActRequest } from "./client-actions.types.js";

const wait = {
  kind: "wait",
  text: "ready",
  textGone: "loading",
  selector: "#result",
  url: "**/done",
  loadState: "networkidle",
  fn: "() => true",
} as const;
function expectTimeout(request: BrowserActRequest, expected: number) {
  expect(resolveBrowserActRequestTimeoutMs(request)).toBe(expected);
}
const batch = (actions: BrowserActRequest[]): BrowserActRequest => ({ kind: "batch", actions });

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
    expectTimeout({ ...wait, timeoutMs: 1 }, 8_000);
    expectTimeout(batch([{ ...wait, timeoutMs: Number.MAX_VALUE }]), 725_000);
  });

  it("keeps Playwright text whitespace in sequential batch budgets", () => {
    const whitespaceWait = {
      kind: "wait",
      timeMs: 0,
      text: " ",
      textGone: " ",
      selector: "",
      url: " ",
      fn: " ",
    } as const;
    expectTimeout(batch([whitespaceWait, whitespaceWait]), 85_000);
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
    expectTimeout(
      batch([
        {
          kind: "fill",
          fields: [
            { ref: "first", type: "text" },
            { ref: "second", type: "text" },
          ],
          timeoutMs: 40_000,
        },
      ]),
      85_500,
    );
    expectTimeout(
      {
        kind: "type",
        ref: "field",
        text: "value",
        slowly: true,
        submit: true,
        timeoutMs: 60_000,
      },
      185_250,
    );
    expectTimeout({ kind: "click", ref: "button", delayMs: 5_000, timeoutMs: 20_000 }, 50_250);
    expectTimeout(
      {
        kind: "clickCoords",
        x: 10,
        y: 20,
        doubleClick: true,
        delayMs: 5_000,
        timeoutMs: 1_000,
      },
      21_250,
    );
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
    expectTimeout(
      batch(
        Array.from({ length: 4 }, () => ({
          kind: "scrollIntoView" as const,
          ref: "result",
        })),
      ),
      86_000,
    );
    expectTimeout(batch([{ kind: "scrollIntoView", ref: "result", timeoutMs: 120_000 }]), 125_250);
  });

  it("leaves malformed model batch validation to the browser route", () => {
    expectTimeout(
      {
        kind: "batch",
        requests: [],
        actions: [{ kind: "wait", selector: 1 }, { kind: "unknown" }, null],
      } as unknown as BrowserActRequest,
      65_000,
    );
  });

  it("saturates aggregate and slack arithmetic at the timer limit", () => {
    const actions: BrowserActRequest[] = Array.from({ length: 3_000 }, () => ({
      ...wait,
      loadState: "load",
      timeoutMs: 120_000,
    }));
    expectTimeout(batch(actions), MAX_TIMER_TIMEOUT_MS);
  });
});
