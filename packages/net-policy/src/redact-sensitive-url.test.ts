import { expect, it } from "vitest";
import {
  isSensitiveUrlQueryParamName,
  isSensitiveUrlConfigPath,
  SENSITIVE_URL_HINT_TAG,
  hasSensitiveUrlHintTag,
  redactSensitiveUrl,
  redactSensitiveUrlLikeString,
} from "./redact-sensitive-url.js";

function encodeRepeatedly(raw: string, layers: number): string {
  let value = raw;
  for (let index = 0; index < layers; index += 1) {
    value = encodeURIComponent(value);
  }
  return value;
}

const proxyUrl = (value: string) => `https://outer.example/proxy/${value}`;
const queryUrl = (value: string) => `https://outer.example/?next=${value}`;
const exampleUrl = (value: string) => `https://example.com/${value}`;
const botToken = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd";
const mmsKey = `__openclaw_mms_token_${"a".repeat(24)}`;
const credentials = "https://USER:PASS@inner.example/";
const encodedScheme = "%68%74%74%70%73%3A%2F%2F";

it.each([
  [exampleUrl("?client%5Fse%E2%80%8Bcret=s&ok=1"), exampleUrl("?client_se%E2%80%8Bcret=***&ok=1")],
  [
    exampleUrl("?sig=1&X-Api-Key=2&x_access_token=3&x-auth-token=4&signal=keep&x-api-version=1"),
    exampleUrl(
      "?sig=***&X-Api-Key=***&x_access_token=***&x-auth-token=***&signal=keep&x-api-version=1",
    ),
  ],
  [
    exampleUrl(`?upstream-token=keep&${mmsKey}=${"b".repeat(48)}`),
    exampleUrl(`?upstream-token=***&${mmsKey}=***`),
  ],
  [`https://telegram.internal/bot${botToken}/getMe`, "https://telegram.internal/bot***/getMe"],
  [
    `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getMe`,
    "https://api.telegram.org/bot***/getMe",
  ],
  [
    `https://example.com/cb#${encodeURIComponent("access_token=secret&keep=visible")}`,
    "https://example.com/cb#access_token%3D***%26keep%3Dvisible",
  ],
  [exampleUrl("?keep=1&keep=2&token=a&token=b"), exampleUrl("?keep=1&keep=2&token=***")],
])("redacts secrets without changing safe URL components: %s", (value, expected) => {
  expect(redactSensitiveUrl(value)).toBe(expected);
});

it.each([
  "https://outer.example/proxy/%2A%2A%2A",
  "https://example.com/cb#keep%3Dvisible%26next%3Dsafe",
  "https://outer.example/cb?next=https%3A%2F%2Finner.example%2Fpath%3Fkeep%3Dvisible&keep=one&keep=two#https%3A%2F%2Ffragment.example%2Fpath%3Fok%3D1",
])("preserves safe URL bytes: %s", (value) => {
  expect(redactSensitiveUrl(value)).toBe(value);
});

it("fails closed when nested URL encoding exceeds the recursion bound", () => {
  let nested = "https://inner.example/?keep=visible";
  for (let index = 0; index < 12; index += 1) {
    nested = `https://level-${index}.example/?next=${encodeURIComponent(nested)}`;
  }
  const redacted = redactSensitiveUrl(nested);
  expect(new URL(redacted).hostname).toBe("level-11.example");
  expect(redacted).not.toContain("inner.example");
  expect(redacted).toContain("***");
});

it.each([
  [queryUrl(encodeRepeatedly("https://inner.example/?keep=visible", 21)), queryUrl("***")],
  ["//e/?client_se%20cret=s&client_se%00cret=n", "//e/?client_se%20cret=***&client_se%00cret=***"],
  [
    "wss://user:pass@[bad-host/?token=secret&keep=visible)",
    "wss://***:***@[bad-host/?token=***&keep=visible)",
  ],
  [
    "fatal: retry https://first:pass@one.example then https://second:pass@two.example",
    "fatal: retry https://***:***@one.example then https://***:***@two.example",
  ],
  ["https://outer.example/#access_token%3Dmalformed-secret%ZZ", "https://outer.example/#***"],
])("redacts malformed, diagnostic, or over-encoded URL %s", (value, expected) => {
  expect(redactSensitiveUrlLikeString(value)).toBe(expected);
});

it("matches the auth-oriented query params used by MCP SSE config redaction", () => {
  const names =
    "refresh_token access-token hook-token passwd signature code " +
    "x-amz-signature X-Amz-Security-Token id_token app_secret client_se\u3164cret credential";
  for (const name of names.split(" ")) {
    expect(isSensitiveUrlQueryParamName(name), name).toBe(true);
  }
  for (const name of ["sigmoid", "token_count", "x-request-id"]) {
    expect(isSensitiveUrlQueryParamName(name), name).toBe(false);
  }
});

it("recognizes config paths that may embed URL secrets", () => {
  expect(isSensitiveUrlConfigPath("models.providers.*.baseUrl")).toBe(true);
  expect(isSensitiveUrlConfigPath("mcp.servers.remote.url")).toBe(true);
  expect(isSensitiveUrlConfigPath("nodeHost.mcp.servers.remote.url")).toBe(true);
  expect(isSensitiveUrlConfigPath("browser.cdpUrl")).toBe(true);
  expect(isSensitiveUrlConfigPath("browser.profiles.remote.cdpUrl")).toBe(true);
  expect(isSensitiveUrlConfigPath("gateway.remote.url")).toBe(false);
});

it("uses an explicit url-secret hint tag", () => {
  expect(SENSITIVE_URL_HINT_TAG).toBe("url-secret");
  expect(hasSensitiveUrlHintTag({ tags: [SENSITIVE_URL_HINT_TAG] })).toBe(true);
  expect(hasSensitiveUrlHintTag({ tags: ["security"] })).toBe(false);
});

function expectRedacted(value: string, secrets = ["USER", "PASS"], marker = "***"): void {
  const redacted = redactSensitiveUrlLikeString(value);
  for (const secret of secrets) {
    expect(redacted).not.toContain(secret);
  }
  expect(redacted).toContain(marker);
}

it.each([`https://outer.example/?${credentials}=v`, `https://outer.example/#/cb?${credentials}=v`])(
  "redacts credentials in query names: %s",
  (value) => expectRedacted(value),
);

it.each(["%2F", "%3F", "%23"])("redacts reserved userinfo character %s", (reserved) => {
  const nested = `${encodedScheme}USER%3APASS${reserved}part%40inner.example%2F`;
  expectRedacted(proxyUrl(nested), undefined, "***:***@inner.example/");
});

it.each(["USER%3APASS%20part%40", "USER%2Fpart%3APASS%40", "USER%2Fpart%40"])(
  "fails closed for unresolved encoded userinfo: %s",
  (userinfo) => {
    expectRedacted(proxyUrl(`${encodedScheme}${userinfo}inner.example%2F`));
  },
);

it.each<[string, string?]>([
  ["//USER%2Fpart%3APASS%40inner.example"],
  [queryUrl("https%3A%2F%2FUSER%2Fpart%3APASS%40inner.example%2F")],
  [queryUrl(encodeURIComponent("callback#access_token=USER-PASS"))],
  [proxyUrl("//USER@USER2:PASS@inner.example/"), "***:***@inner.example/"],
  [`data:text/plain,${encodeURIComponent(credentials)}`, "***:***@inner.example/"],
])("redacts ambiguous or opaque embedded URL %s", (value, marker) => {
  expectRedacted(value, undefined, marker);
});

it("preserves encoded safe URLs when paths, queries, or fragments contain an at sign", () => {
  for (const nested of [
    "https://inner.example/path@label",
    "https://inner.example?email=user@example.com",
    "https://inner.example#user@example.com",
    "https://inner.example:443/path@label",
    "https://inner.example:443?email=user@example.com",
    "https://[2001:db8::1]/path@label",
    "https://[2001:db8::1]#user@example.com",
  ]) {
    const encoded = encodeURIComponent(nested);
    for (const outer of [encoded, proxyUrl(encoded), queryUrl(encoded)]) {
      expect(redactSensitiveUrlLikeString(outer)).toBe(outer);
    }
  }
});

it("redacts a percent-encoded credential-bearing URL in an outer URL path", () => {
  for (const layers of [1, 2, 20]) {
    expectRedacted(proxyUrl(encodeRepeatedly(`${credentials}?token=TOKEN`, layers)), [
      "USER",
      "PASS",
      "TOKEN",
    ]);
  }
});

it("redacts mixed literal and encoded credentials in one fragment", () => {
  const encoded = encodeURIComponent("https://USER2:PASS2@two.example/");
  expectRedacted(`https://outer.example/#diagnostic ${credentials} then ${encoded}`);
});

it("redacts repeatedly encoded sensitive query parameter names", () => {
  for (const layers of [0, 1, 8, 20]) {
    expectRedacted(exampleUrl(`?${encodeRepeatedly("%74oken", layers)}=SECRET`), ["SECRET"]);
  }
});

// The nested-URL rules only ran when the whole string parsed as one URL. For
// anything else the fallback scan took `[^&]*` as the value, so a nested query
// was swallowed whole and its credential never classified -- while the same URL
// alone was redacted. Callers pass whole lines here (git output, download
// failures), so one leading word was enough to leak.
it.each([
  ["fetching ", " now"],
  ["fatal: unable to access ", ": 403"],
])("redacts a nested credential when text precedes the outer URL: %s", (prefix, suffix) => {
  const inner = "https://app.test/cb?access_token=synthetic-secret-0123456789";
  for (const nested of [inner, encodeURIComponent(inner)]) {
    expectRedacted(`${prefix}https://auth.test/a?redirect_uri=${nested}${suffix}`, [
      "synthetic-secret-0123456789",
    ]);
  }
});

it("keeps a nested URL without credentials readable in embedded text", () => {
  const value = "fetching https://auth.test/a?redirect_uri=https://app.test/cb?page=2 now";
  expect(redactSensitiveUrlLikeString(value)).toBe(value);
});

// Nested scanning must not shorten a mask. A raw "?" or space can sit inside a
// value, so a sensitive value is still masked to the end of its `[^&]*` run, and
// only a value whose own name is not sensitive is scanned for nesting. That is
// what keeps this additive: nothing masked before becomes readable.
it.each(["alpha?bravo", "alpha bravo"])(
  "masks a sensitive value whole when it contains a nested separator: %s",
  (secret) => {
    expect(redactSensitiveUrlLikeString(`fetching https://example.test/?password=${secret}`)).toBe(
      "fetching https://example.test/?password=***",
    );
  },
);

it("still classifies a credential name spliced with whitespace in embedded text", () => {
  expect(
    redactSensitiveUrlLikeString(
      "fetching https://example.test/?access_ token=synthetic-secret-0123456789",
    ),
  ).toBe("fetching https://example.test/?access_ token=***");
});
