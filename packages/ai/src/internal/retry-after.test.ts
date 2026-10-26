import { describe, expect, it, vi } from "vitest";
import {
  hasExplicitRetryText,
  parseGoogleRetryDelaySeconds as googleDelay,
  parseRetryAfterErrorSeconds as errorSeconds,
  parseRetryAfterErrorTiming as errorTiming,
  parseRetryAfterHeadersSeconds as headerSeconds,
  parseRetryAfterTextSeconds as textSeconds,
  resolveProviderErrorRetrySeconds as providerSeconds,
  parseRetryAfterHttpDateMs as parseDate,
} from "./retry-after.js";

const EXAMPLE_TIMESTAMP = Date.UTC(1994, 10, 6, 8, 49, 37);
const quotaHeaders = (dimension: string, remaining: string, reset: string) => ({
  [`x-ratelimit-remaining-${dimension}`]: remaining,
  [`x-ratelimit-reset-${dimension}`]: reset,
});
const anthropicQuotaHeaders = (dimension: string, remaining: string, reset: string) => ({
  [`anthropic-ratelimit-${dimension}-remaining`]: remaining,
  [`anthropic-ratelimit-${dimension}-reset`]: reset,
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
    // An explicit retry instruction outranks a bucket's full-refill time.
    [{ "retry-after": "7", ...quotaHeaders("tokens", "0", "9s") }, 7],
    [anthropicQuotaHeaders("output-tokens", "0", "1994-11-06T08:49:42Z"), 12],
    [anthropicQuotaHeaders("requests", "0", "1994-11-06T08:49:31.5Z"), 1.5],
    [anthropicQuotaHeaders("tokens", "12", "1994-11-06T08:49:42Z"), undefined],
    [anthropicQuotaHeaders("input-tokens", "0", "later"), undefined],
    [{ "retry-after": "3", ...anthropicQuotaHeaders("tokens", "0", "1994-11-06T08:50:30Z") }, 3],
  ])("keeps the greatest valid native and record floor: %j", (headers, expected) => {
    const native = new Headers(Object.entries(headers).map(([key, value]) => [key, String(value)]));
    for (const source of [headers, native]) {
      expect(headerSeconds(source, EXAMPLE_TIMESTAMP - 7000, 429)).toBe(expected);
    }
  });

  it.each([undefined, 200, 503])("does not infer a quota wait from HTTP %s", (status) => {
    expect(
      headerSeconds(quotaHeaders("tokens", "0", "1m"), EXAMPLE_TIMESTAMP, status),
    ).toBeUndefined();
  });

  it("reads native Headers without calling an overridden get method", () => {
    const headers = new Headers({ "retry-after": "7" });
    headers.get = () => {
      throw new Error("overridden get called");
    };
    expect(headerSeconds(headers)).toBe(7);
  });

  it.each(["retry-after", "retry-after-ms"])("fails closed on unsafe numeric %s values", (key) => {
    expect(headerSeconds({ [key]: 1e30 })).toBe(Infinity);
    expect(headerSeconds({ [key]: Infinity })).toBe(Infinity);
  });

  it("reads only own timing data without invoking metadata accessors", () => {
    const get = vi.fn(() => {
      throw new Error("getter called");
    });
    const headers = Object.defineProperties(
      { "Retry-After": 7 },
      {
        "retry-after-ms": { get },
        unrelated: { get },
        toJSON: { get },
      },
    );
    expect(headerSeconds(headers)).toBe(7);
    expect(errorSeconds(Object.defineProperty({}, "headers", { get }))).toBeUndefined();
    expect(errorSeconds(Object.create({ headers }))).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it("combines SDK and response header floors", () => {
    const error = {
      headers: new Headers({ "retry-after": "7" }),
      response: { headers: { "Retry-After-Ms": 8500 } },
    };
    expect(errorSeconds(error)).toBe(8.5);
  });

  it("ignores malformed and revoked metadata", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    for (const headers of [undefined, null, 42, "retry-after: 7", proxy]) {
      expect(headerSeconds(headers)).toBeUndefined();
      expect(errorSeconds({ headers })).toBeUndefined();
    }
    expect(errorSeconds(proxy)).toBeUndefined();
  });
});

describe("provider error retry authority", () => {
  const exhausted = { status: 429, headers: quotaHeaders("tokens", "0", "5m") };

  it("separates explicit instructions from bucket refills", () => {
    const error = { ...exhausted, response: { headers: { "retry-after": "4" } } };
    expect(errorTiming(exhausted)).toEqual({ resetSeconds: 300 });
    expect(errorTiming(error)).toEqual({ explicitSeconds: 4, resetSeconds: 300 });
    expect(errorSeconds(error)).toBe(4);
  });

  it("drops a refill reset when the provider wrote an explicit retry time", () => {
    expect(providerSeconds(exhausted)).toBe(300);
    for (const message of ["Please try again in 6s.", "Please retry in 32.5s.", "Retry-After: 2"]) {
      expect(providerSeconds({ ...exhausted, message })).toBeUndefined();
    }
    for (const message of ["Please try again later.", "Please try again in 6 attempts."]) {
      expect(providerSeconds({ ...exhausted, message })).toBe(300);
    }
    expect(
      providerSeconds({
        ...exhausted,
        message: "Please try again in 6s.",
        body: '{"details":[{"retryDelay":"8s"}]}',
      }),
    ).toBe(8);
  });

  it("recognizes explicit retry prose only with a parseable time", () => {
    expect(hasExplicitRetryText("try again in 6s")).toBe(true);
    expect(hasExplicitRetryText("Retry-After: Sun, 06 Nov 1994 08:49:37 GMT")).toBe(true);
    expect(hasExplicitRetryText("please try again in a moment")).toBe(false);
    expect(hasExplicitRetryText("please try again in 6 attempts")).toBe(false);
    expect(hasExplicitRetryText(undefined)).toBe(false);
  });

  it("parses retry-text durations with the same grammar the failover path uses", () => {
    expect(textSeconds("6s")).toBe(6);
    expect(textSeconds("250ms")).toBe(0.25);
    expect(textSeconds("2 minutes")).toBe(120);
    expect(textSeconds("1.5 hours")).toBe(5400);
    expect(textSeconds("7")).toBe(7);
    expect(textSeconds("Sun, 06 Nov 1994 08:49:44 GMT", EXAMPLE_TIMESTAMP)).toBe(7);
    for (const invalid of ["6 attempts", "a moment", "-1s", ""]) {
      expect(textSeconds(invalid)).toBeUndefined();
    }
  });

  it("reads RetryInfo in any key order without invoking getters", () => {
    const retryInfo = (retryDelay: unknown) => ({
      error: { details: [{ retryDelay, "@type": "type.googleapis.com/google.rpc.RetryInfo" }] },
    });
    expect(googleDelay(retryInfo("1.25s"))).toBe(1.25);
    expect(googleDelay(JSON.stringify(retryInfo("7s")))).toBe(7);
    for (const invalid of ["soon", "7", 7, "-1s"]) {
      expect(googleDelay(retryInfo(invalid))).toBeUndefined();
    }
    const get = vi.fn(() => [
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "9s" },
    ]);
    expect(googleDelay(Object.defineProperty({}, "details", { get }))).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("parseRetryAfterHttpDateMs", () => {
  it.each<[string, number | undefined, number?]>([
    ["Sun, 06 Nov 1994 08:49:37 GMT", EXAMPLE_TIMESTAMP, Date.UTC(1994, 0, 1)],
    ["Sunday, 06-Nov-94 08:49:37 GMT", EXAMPLE_TIMESTAMP, Date.UTC(1994, 0, 1)],
    ["Sun Nov  6 08:49:37 1994", EXAMPLE_TIMESTAMP],
    ["Sun Nov 06 08:49:37 1994", EXAMPLE_TIMESTAMP],
    ["Sun, 31 Feb 2027 00:00:00 GMT", undefined],
    ["Sunday, 31-Feb-27 00:00:00 GMT", undefined],
    ["Sun Feb 31 00:00:00 2027", undefined],
    ["Thu, 29 Feb 2027 00:00:00 GMT", undefined],
    ["Mon, 06 Nov 1994 08:49:37 GMT", undefined],
    ["Monday, 06-Nov-94 08:49:37 GMT", undefined],
    ["Mon Nov  6 08:49:37 1994", undefined],
    ["sun, 06 Nov 1994 08:49:37 GMT", undefined],
    ["Sun, 06 Nov 1899 08:49:37 GMT", undefined],
    ["Sun, 06 Nov 1994 24:00:00 GMT", undefined],
    ["Sun, 06 Nov 1994 08:60:00 GMT", undefined],
    ["Sun, 06 Nov 1994 08:49:61 GMT", undefined],
    ["Sun, 6 Nov 1994 08:49:37 GMT", undefined],
    ["Sun Nov 6 08:49:37 1994", undefined],
    ["Sat, 31 Dec 2016 23:59:60 GMT", Date.UTC(2017, 0, 1)],
    ["Sunday, 06-Nov-50 00:00:00 GMT", Date.UTC(2050, 10, 6)],
    ["Sunday, 06-Nov-77 00:00:00 GMT", Date.UTC(1977, 10, 6)],
  ])(
    "validates HTTP-date grammar, calendar, leap seconds and rolling years: %s",
    (value, expected, now = Date.UTC(2026, 10, 6)) => {
      expect(parseDate(value, now)).toBe(expected);
    },
  );
});
