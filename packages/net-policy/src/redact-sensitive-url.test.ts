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

it.each([
  [
    "https://example.com/mcp?client%5Fse%E2%80%8Bcret=secret&safe=value",
    "https://example.com/mcp?client_se%E2%80%8Bcret=***&safe=value",
  ],
  [
    "https://example.com/mcp?sig=one&X-Api-Key=two&x_access_token=three&x-auth-token=four&signal=keep&x-api-version=1",
    "https://example.com/mcp?sig=***&X-Api-Key=***&x_access_token=***&x-auth-token=***&signal=keep&x-api-version=1",
  ],
  [
    `https://gateway.example.com/webhooks/sms?upstream-token=keep&__openclaw_mms_token_${"a".repeat(24)}=${"b".repeat(48)}`,
    `https://gateway.example.com/webhooks/sms?upstream-token=***&__openclaw_mms_token_${"a".repeat(24)}=***`,
  ],
  [
    "https://telegram.internal/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd/getMe",
    "https://telegram.internal/bot***/getMe",
  ],
  [
    "https://api.telegram.org/bot123456%3AABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd/getMe",
    "https://api.telegram.org/bot***/getMe",
  ],
  [
    `https://example.com/cb#${encodeURIComponent("access_token=secret&keep=visible")}`,
    "https://example.com/cb#access_token%3D***%26keep%3Dvisible",
  ],
  [
    "https://example.com/?keep=one&keep=two&token=a&token=b",
    "https://example.com/?keep=one&keep=two&token=***",
  ],
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

it("fails closed when one nested URL exceeds the percent-encoding bound", () => {
  const nested = encodeRepeatedly("https://inner.example/?keep=visible", 20);
  const redacted = redactSensitiveUrl(queryUrl(encodeURIComponent(nested)));
  expect(redacted).toBe("https://outer.example/?next=***");
});

it("redacts encoded query names with decoded whitespace and control separators in invalid URL-like strings", () => {
  expect(
    redactSensitiveUrlLikeString(
      "//example.com/mcp?client%5Fse%20cret=space&client%5Fse%00cret=nul",
    ),
  ).toBe("//example.com/mcp?client%5Fse%20cret=***&client%5Fse%00cret=***");
});

it("redacts protocol URLs that are too malformed to parse", () => {
  expect(
    redactSensitiveUrlLikeString(
      "wss://fallback-user:fallback-pass@[bad-host/socket?token=fallback-secret&keep=visible)",
    ),
  ).toBe("wss://***:***@[bad-host/socket?token=***&keep=visible)");
});

it("matches the auth-oriented query params used by MCP SSE config redaction", () => {
  expect(isSensitiveUrlQueryParamName("refresh_token")).toBe(true);
  expect(isSensitiveUrlQueryParamName("access-token")).toBe(true);
  expect(isSensitiveUrlQueryParamName("hook-token")).toBe(true);
  expect(isSensitiveUrlQueryParamName("passwd")).toBe(true);
  expect(isSensitiveUrlQueryParamName("signature")).toBe(true);
  expect(isSensitiveUrlQueryParamName("code")).toBe(true);
  expect(isSensitiveUrlQueryParamName("x-amz-signature")).toBe(true);
  expect(isSensitiveUrlQueryParamName("X-Amz-Security-Token")).toBe(true);
  expect(isSensitiveUrlQueryParamName("id_token")).toBe(true);
  expect(isSensitiveUrlQueryParamName("app_secret")).toBe(true);
  expect(isSensitiveUrlQueryParamName("client_se\u3164cret")).toBe(true);
  expect(isSensitiveUrlQueryParamName("credential")).toBe(true);
  expect(isSensitiveUrlQueryParamName("sigmoid")).toBe(false);
  expect(isSensitiveUrlQueryParamName("token_count")).toBe(false);
  expect(isSensitiveUrlQueryParamName("x-request-id")).toBe(false);
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

function expectRedacted(value: string, secrets: string[], marker = "***"): void {
  const redacted = redactSensitiveUrlLikeString(value);
  for (const secret of secrets) {
    expect(redacted).not.toContain(secret);
  }
  expect(redacted).toContain(marker);
}

it("redacts embedded credentials from query parameter names", () => {
  const nestedKey = "https://key-user:key-pass@inner.example/";
  for (const value of [
    `https://outer.example/?${nestedKey}=value`,
    `https://outer.example/#/cb?${nestedKey}=value`,
  ]) {
    expectRedacted(value, ["key-user", "key-pass"]);
  }
});

it("redacts encoded reserved characters inside nested userinfo", () => {
  for (const encodedReserved of ["%2F", "%3F", "%23"]) {
    const encodedNested = `%68%74%74%70%73%3A%2F%2Fencoded-user%3Aencoded-pass${encodedReserved}part%40inner.example%2F`;
    expectRedacted(
      proxyUrl(encodedNested),
      ["encoded-user", "encoded-pass"],
      "***:***@inner.example/",
    );
  }
});

it("fails closed for unresolved encoded userinfo delimiters", () => {
  for (const encodedUserInfo of [
    "encoded-user%3Aencoded-pass%20part%40",
    "encoded-user%2Fpart%3Aencoded-pass%40",
    "encoded-user%2Fpart%40",
  ]) {
    const encodedNested = `%68%74%74%70%73%3A%2F%2F${encodedUserInfo}inner.example%2F`;
    expectRedacted(proxyUrl(encodedNested), ["encoded-user", "encoded-pass"]);
  }
});

it.each<[string, string, string[], string?]>([
  [
    "unresolved protocol-relative userinfo",
    "//relative-user%2Fpart%3Arelative-pass%40inner.example",
    ["relative-user", "relative-pass"],
  ],
  [
    "ambiguous userinfo in a nested query value",
    queryUrl("https%3A%2F%2Fquery-user%2Fpart%3Aquery-pass%40inner.example%2F"),
    ["query-user", "query-pass"],
  ],
  [
    "an encoded relative fragment in a nested query value",
    queryUrl(encodeURIComponent("callback#access_token=relative-secret")),
    ["relative-secret"],
  ],
  [
    "the final userinfo delimiter in a protocol-relative URL",
    proxyUrl("//first-user@second-user:multi-pass@inner.example/"),
    ["first-user", "second-user", "multi-pass"],
    "***:***@inner.example/",
  ],
  [
    "an opaque URL whose pathname cannot be assigned",
    `data:text/plain,${encodeURIComponent("https://opaque-user:opaque-pass@inner.example/")}`,
    ["opaque-user", "opaque-pass"],
    "***:***@inner.example/",
  ],
])("redacts %s", (_name, value, secrets, marker) => {
  expectRedacted(value, secrets, marker);
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
    expect(redactSensitiveUrlLikeString(encoded)).toBe(encoded);
    for (const outer of [proxyUrl(encoded), queryUrl(encoded)]) {
      expect(redactSensitiveUrlLikeString(outer)).toBe(outer);
    }
  }
});

it("redacts embedded URLs when a diagnostic prefix parses as an opaque scheme", () => {
  expect(
    redactSensitiveUrlLikeString(
      "fatal: retry https://first:first-pass@one.example then https://second:second-pass@two.example",
    ),
  ).toBe("fatal: retry https://***:***@one.example then https://***:***@two.example");
});

it("redacts a percent-encoded credential-bearing URL in an outer URL path", () => {
  const nested = "https://path-user:path-pass@inner.example/?token=path-token";
  for (const layers of [1, 2, 20]) {
    const encoded = encodeRepeatedly(nested, layers);
    expectRedacted(proxyUrl(encoded), ["path-user", "path-pass", "path-token"]);
  }
});

it("fails closed when an encoded fragment also has a malformed escape", () => {
  const value = "https://outer.example/#access_token%3Dmalformed-secret%ZZ";
  const redacted = redactSensitiveUrlLikeString(value);
  expect(redacted).toBe("https://outer.example/#***");
});

it("redacts mixed literal and encoded credentials in one fragment", () => {
  const literal = "https://literal-user:literal-pass@one.example/";
  const encoded = encodeURIComponent("https://encoded-user:encoded-pass@two.example/");
  const redacted = redactSensitiveUrlLikeString(
    `https://outer.example/#diagnostic ${literal} then ${encoded}`,
  );
  expect(redacted).not.toContain("literal-user");
  expect(redacted).not.toContain("literal-pass");
  expect(redacted).not.toContain("encoded-user");
  expect(redacted).not.toContain("encoded-pass");
});

it("redacts repeatedly encoded sensitive query parameter names", () => {
  for (const layers of [0, 1, 8, 20]) {
    const key = encodeRepeatedly("%74oken", layers);
    const value = `https://example.test/?${key}=encoded-name-secret`;
    expectRedacted(value, ["encoded-name-secret"]);
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
