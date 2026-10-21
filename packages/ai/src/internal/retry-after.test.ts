import { describe, expect, it } from "vitest";
import {
  parseRetryAfterErrorSeconds,
  parseRetryAfterHeadersSeconds,
  parseRetryAfterHttpDateMs as parseDate,
} from "./retry-after.js";

const EXAMPLE_TIMESTAMP = Date.UTC(1994, 10, 6, 8, 49, 37);
const quotaHeaders = (dimension: string, remaining: string, reset: string) => ({
  [`x-ratelimit-remaining-${dimension}`]: remaining,
  [`x-ratelimit-reset-${dimension}`]: reset,
});

describe("retry header floors", () => {
  it.each<[Record<string, string | number>, number | undefined]>([
    [{ "retry-after": "7", "retry-after-ms": "335" }, 7],
    [{ "Retry-After": 7, "retry-after-ms": 8500 }, 8.5],
    [{ "retry-after": "7", "retry-after-ms": "invalid" }, 7],
    [{ "retry-after": "7", "retry-after-ms": "0" }, 7],
    [{ "retry-after": "Sun, 06 Nov 1994 08:49:37 GMT", "retry-after-ms": "335" }, 7],
    [{ "retry-after": "9007199254740993", "retry-after-ms": "335" }, Infinity],
    [{ "retry-after-ms": "9007199254740993" }, Infinity],
    [{ "retry-after": "120 seconds", "retry-after-ms": "90000ms" }, undefined],
    [quotaHeaders("tokens", "0", "1m2.5s"), 62.5],
    [quotaHeaders("requests", "0", "250ms"), 0.25],
    [quotaHeaders("project-tokens", "0", "2s"), 2],
    [quotaHeaders("tokens", "1", "1m"), undefined],
    [{ "x-ratelimit-reset-tokens": "1m" }, undefined],
    [quotaHeaders("tokens", "0", "tomorrow"), undefined],
    [{ "retry-after": "7", ...quotaHeaders("tokens", "0", "9s") }, 9],
  ])("keeps the greatest valid native and record floor: %j", (headers, expected) => {
    const native = new Headers(Object.entries(headers).map(([key, value]) => [key, String(value)]));
    for (const source of [headers, native]) {
      expect(parseRetryAfterHeadersSeconds(source, EXAMPLE_TIMESTAMP - 7000, 429)).toBe(expected);
    }
  });

  it.each([undefined, 200, 503])("does not infer a quota wait from HTTP %s", (status) => {
    expect(
      parseRetryAfterHeadersSeconds(quotaHeaders("tokens", "0", "1m"), EXAMPLE_TIMESTAMP, status),
    ).toBeUndefined();
  });

  it("reads native Headers without calling an overridden get method", () => {
    const headers = new Headers({ "retry-after": "7" });
    headers.get = () => {
      throw new Error("overridden get called");
    };
    expect(parseRetryAfterHeadersSeconds(headers)).toBe(7);
  });

  it.each(["retry-after", "retry-after-ms"])("fails closed on unsafe numeric %s values", (key) => {
    expect(parseRetryAfterHeadersSeconds({ [key]: 1e30 })).toBe(Infinity);
    expect(parseRetryAfterHeadersSeconds({ [key]: Infinity })).toBe(Infinity);
  });

  it("reads only own timing data without invoking metadata accessors", () => {
    let invoked = false;
    const getter = () => {
      invoked = true;
      throw new Error("getter called");
    };
    const headers = Object.defineProperties(
      { "Retry-After": 7 },
      {
        "retry-after-ms": { get: getter },
        unrelated: { get: getter },
        toJSON: { get: getter },
      },
    );
    expect(parseRetryAfterHeadersSeconds(headers)).toBe(7);
    expect(
      parseRetryAfterErrorSeconds(Object.defineProperty({}, "headers", { get: getter })),
    ).toBeUndefined();
    expect(parseRetryAfterErrorSeconds(Object.create({ headers }))).toBeUndefined();
    expect(invoked).toBe(false);
  });

  it("combines SDK and response header floors", () => {
    expect(
      parseRetryAfterErrorSeconds({
        headers: new Headers({ "retry-after": "7" }),
        response: { headers: { "Retry-After-Ms": 8500 } },
      }),
    ).toBe(8.5);
  });

  it("ignores malformed and revoked metadata", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    for (const headers of [undefined, null, 42, "retry-after: 7", proxy]) {
      expect(parseRetryAfterHeadersSeconds(headers)).toBeUndefined();
      expect(parseRetryAfterErrorSeconds({ headers })).toBeUndefined();
    }
    expect(parseRetryAfterErrorSeconds(proxy)).toBeUndefined();
  });
});

describe("parseRetryAfterHttpDateMs", () => {
  it.each([
    ["IMF-fixdate", "Sun, 06 Nov 1994 08:49:37 GMT"],
    ["RFC 850", "Sunday, 06-Nov-94 08:49:37 GMT"],
    ["asctime single-digit day", "Sun Nov  6 08:49:37 1994"],
    ["asctime two-digit day", "Sun Nov 06 08:49:37 1994"],
  ])("parses %s", (_label, value) => {
    expect(parseDate(value, Date.UTC(1994, 0, 1))).toBe(EXAMPLE_TIMESTAMP);
  });

  it.each([
    "Sun, 31 Feb 2027 00:00:00 GMT",
    "Sunday, 31-Feb-27 00:00:00 GMT",
    "Sun Feb 31 00:00:00 2027",
    "Thu, 29 Feb 2027 00:00:00 GMT",
    "Mon, 06 Nov 1994 08:49:37 GMT",
    "Monday, 06-Nov-94 08:49:37 GMT",
    "Mon Nov  6 08:49:37 1994",
    "sun, 06 Nov 1994 08:49:37 GMT",
    "Sun, 06 Nov 1899 08:49:37 GMT",
    "Sun, 06 Nov 1994 24:00:00 GMT",
    "Sun, 06 Nov 1994 08:60:00 GMT",
    "Sun, 06 Nov 1994 08:49:61 GMT",
    "Sun, 6 Nov 1994 08:49:37 GMT",
    "Sun Nov 6 08:49:37 1994",
  ])("rejects invalid HTTP-date calendar, weekday or grammar: %s", (value) => {
    expect(parseDate(value, Date.UTC(2026, 10, 6))).toBeUndefined();
  });

  it("accepts the HTTP-date leap-second range", () => {
    expect(parseDate("Sat, 31 Dec 2016 23:59:60 GMT")).toBe(Date.UTC(2017, 0, 1));
  });

  it("uses the RFC 850 rolling 50-year rule before validating the weekday", () => {
    const now = Date.UTC(2026, 10, 6);
    expect(parseDate("Sunday, 06-Nov-50 00:00:00 GMT", now)).toBe(Date.UTC(2050, 10, 6));
    expect(parseDate("Sunday, 06-Nov-77 00:00:00 GMT", now)).toBe(Date.UTC(1977, 10, 6));
  });
});
