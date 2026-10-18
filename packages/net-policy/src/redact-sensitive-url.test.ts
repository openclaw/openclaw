import { describe, expect, it } from "vitest";
import {
  isSensitiveUrlQueryParamName,
  isSensitiveUrlConfigPath,
  SENSITIVE_URL_HINT_TAG,
  hasSensitiveUrlHintTag,
  redactSensitiveUrl,
  redactSensitiveUrlLikeString,
} from "./redact-sensitive-url.js";

describe("redactSensitiveUrl", () => {
  it("redacts encoded and invisible-spliced sensitive query param names", () => {
    expect(
      redactSensitiveUrl("https://example.com/mcp?client%5Fse%E2%80%8Bcret=secret&safe=value"),
    ).toBe("https://example.com/mcp?client_se%E2%80%8Bcret=***&safe=value");
  });

  it("redacts signed and x-* auth aliases without matching adjacent metadata", () => {
    expect(
      redactSensitiveUrl(
        "https://example.com/mcp?sig=one&X-Api-Key=two&x_access_token=three&x-auth-token=four&signal=keep&x-api-version=1",
      ),
    ).toBe(
      "https://example.com/mcp?sig=***&X-Api-Key=***&x_access_token=***&x-auth-token=***&signal=keep&x-api-version=1",
    );
  });

  it("redacts resource-scoped bearer token query params", () => {
    expect(
      redactSensitiveUrl(
        `https://gateway.example.com/webhooks/sms?upstream-token=keep&__openclaw_mms_token_${"a".repeat(24)}=${"b".repeat(48)}`,
      ),
    ).toBe(
      `https://gateway.example.com/webhooks/sms?upstream-token=***&__openclaw_mms_token_${"a".repeat(24)}=***`,
    );
  });

  it("redacts Telegram bot tokens from URL paths", () => {
    expect(
      redactSensitiveUrl(
        "https://telegram.internal/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd/getMe",
      ),
    ).toBe("https://telegram.internal/bot***/getMe");
    expect(
      redactSensitiveUrl(
        "https://api.telegram.org/bot123456%3AABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd/getMe",
      ),
    ).toBe("https://api.telegram.org/bot***/getMe");
  });

  it("redacts sensitive encoded fragments without changing safe encoded fragments", () => {
    const sensitiveFragment = encodeURIComponent(
      joinUrlParts("access", "_token", "=", "secret", "&keep=visible"),
    );
    expect(redactSensitiveUrl(`https://example.com/cb#${sensitiveFragment}`)).toBe(
      "https://example.com/cb#access_token%3D***%26keep%3Dvisible",
    );

    const safeUrl = "https://example.com/cb#keep%3Dvisible%26next%3Dsafe";
    expect(redactSensitiveUrl(safeUrl)).toBe(safeUrl);
  });

  it("preserves safe nested URLs, fragments, and duplicate query ordering byte-for-byte", () => {
    const safeUrl =
      "https://outer.example/cb?next=https%3A%2F%2Finner.example%2Fpath%3Fkeep%3Dvisible&keep=one&keep=two#https%3A%2F%2Ffragment.example%2Fpath%3Fok%3D1";
    expect(redactSensitiveUrl(safeUrl)).toBe(safeUrl);

    expect(
      redactSensitiveUrl(
        joinUrlParts("https://example.com/?keep=one&keep=two&to", "ken=", "a", "&to", "ken=b"),
      ),
    ).toBe(joinUrlParts("https://example.com/?keep=one&keep=two&to", "ken=", "***"));
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
    let nested = "https://inner.example/?keep=visible";
    for (let index = 0; index < 20; index += 1) {
      nested = encodeURIComponent(nested);
    }
    const redacted = redactSensitiveUrl(
      `https://outer.example/?next=${encodeURIComponent(nested)}`,
    );
    expect(redacted).toBe("https://outer.example/?next=***");
  });
});

describe("redactSensitiveUrlLikeString", () => {
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
});

describe("isSensitiveUrlQueryParamName", () => {
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
});

describe("sensitive URL config metadata", () => {
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
});

function joinUrlParts(...parts: string[]): string {
  return parts.join("");
}

function expectRedacted(value: string, secrets: string[], marker = "***"): void {
  const redacted = redactSensitiveUrlLikeString(value);
  for (const secret of secrets) {
    expect(redacted).not.toContain(secret);
  }
  expect(redacted).toContain(marker);
}

describe("nested URL-like fallback redaction", () => {
  it("redacts embedded credentials from query parameter names", () => {
    const nestedKey = joinUrlParts("https://key-user", ":", "key-pass", "@inner.example/");
    for (const value of [
      `https://outer.example/?${nestedKey}=value`,
      `https://outer.example/#/cb?${nestedKey}=value`,
    ]) {
      expectRedacted(value, ["key-user", "key-pass"]);
    }
  });

  it("redacts encoded reserved characters inside nested userinfo", () => {
    for (const encodedReserved of ["%2F", "%3F", "%23"]) {
      const encodedNested = joinUrlParts(
        "%68%74%74%70%73%3A%2F%2Fencoded-user",
        "%3A",
        `encoded-pass${encodedReserved}part%40inner.example%2F`,
      );
      expectRedacted(
        `https://outer.example/proxy/${encodedNested}`,
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
      expectRedacted(`https://outer.example/proxy/${encodedNested}`, [
        "encoded-user",
        "encoded-pass",
      ]);
    }
  });

  it("fails closed for unresolved encoded protocol-relative userinfo", () => {
    const value = joinUrlParts("//relative-user%2Fpart%3A", "relative-pass", "%40inner.example");
    expectRedacted(value, ["relative-user", "relative-pass"]);
  });

  it("fails closed after a nested query value decodes into ambiguous userinfo", () => {
    const nested = joinUrlParts(
      "https%3A%2F%2Fquery-user%2Fpart%3A",
      "query-pass",
      "%40inner.example%2F",
    );
    expectRedacted(`https://outer.example/?next=${nested}`, ["query-user", "query-pass"]);
  });

  it("preserves encoded safe URLs when paths, queries, or fragments contain an at sign", () => {
    const unambiguousEmbeddedUrls = [
      "https://inner.example:443/path@label",
      "https://inner.example:443?email=user@example.com",
      "https://[2001:db8::1]/path@label",
      "https://[2001:db8::1]#user@example.com",
    ];
    const safeUrls = [
      "https://inner.example/path@label",
      "https://inner.example?email=user@example.com",
      "https://inner.example#user@example.com",
      ...unambiguousEmbeddedUrls,
    ];
    for (const nested of safeUrls) {
      const encoded = encodeURIComponent(nested);
      expect(redactSensitiveUrlLikeString(encoded)).toBe(encoded);
      for (const outer of [
        `https://outer.example/proxy/${encoded}`,
        `https://outer.example/?next=${encoded}`,
      ]) {
        expect(redactSensitiveUrlLikeString(outer)).toBe(outer);
      }
    }
  });

  it("redacts embedded URLs when a diagnostic prefix parses as an opaque scheme", () => {
    expect(
      redactSensitiveUrlLikeString(
        joinUrlParts(
          "fatal: retry https://first",
          ":",
          "first-pass",
          "@one.example then https://second",
          ":",
          "second-pass",
          "@two.example",
        ),
      ),
    ).toBe("fatal: retry https://***:***@one.example then https://***:***@two.example");
  });

  it("redacts a percent-encoded credential-bearing URL in an outer URL path", () => {
    const nested = joinUrlParts(
      "https://path-user",
      ":",
      "path-pass",
      "@inner.example/?to",
      "ken=",
      "path-token",
    );
    for (const layers of [1, 2, 20]) {
      let encoded = nested;
      for (let index = 0; index < layers; index += 1) {
        encoded = encodeURIComponent(encoded);
      }
      expectRedacted(`https://outer.example/proxy/${encoded}`, [
        "path-user",
        "path-pass",
        "path-token",
      ]);
    }
  });

  it("fails closed when an encoded fragment also has a malformed escape", () => {
    const value = joinUrlParts(
      "https://outer.example/#access",
      "_token%3D",
      "malformed-secret",
      "%ZZ",
    );
    const redacted = redactSensitiveUrlLikeString(value);
    expect(redacted).not.toContain("malformed-secret");
    expect(redacted).toBe("https://outer.example/#***");
  });

  it("redacts an encoded relative URL fragment in a nested query value", () => {
    const relative = joinUrlParts("callback#access", "_token", "=", "relative-secret");
    const value = `https://outer.example/?next=${encodeURIComponent(relative)}`;
    expectRedacted(value, ["relative-secret"]);
  });

  it("redacts through the final userinfo delimiter in a protocol-relative URL", () => {
    const nested = joinUrlParts("//first-user@second-user", ":", "multi-pass", "@inner.example/");
    expectRedacted(
      `https://outer.example/proxy/${nested}`,
      ["first-user", "second-user", "multi-pass"],
      "***:***@inner.example/",
    );
  });

  it("redacts mixed literal and encoded credentials in one fragment", () => {
    const literal = joinUrlParts("https://literal-user", ":", "literal-pass", "@one.example/");
    const encoded = encodeURIComponent(
      joinUrlParts("https://encoded-user", ":", "encoded-pass", "@two.example/"),
    );
    const redacted = redactSensitiveUrlLikeString(
      `https://outer.example/#diagnostic ${literal} then ${encoded}`,
    );
    expect(redacted).not.toContain("literal-user");
    expect(redacted).not.toContain("literal-pass");
    expect(redacted).not.toContain("encoded-user");
    expect(redacted).not.toContain("encoded-pass");
  });

  it("redacts an opaque URL whose pathname cannot be assigned", () => {
    const nested = encodeURIComponent(
      joinUrlParts("https://opaque-user", ":", "opaque-pass", "@inner.example/"),
    );
    expectRedacted(
      `data:text/plain,${nested}`,
      ["opaque-user", "opaque-pass"],
      "***:***@inner.example/",
    );
  });

  it("redacts repeatedly encoded sensitive query parameter names", () => {
    for (const layers of [0, 1, 8, 20]) {
      let key = "%74oken";
      for (let index = 0; index < layers; index += 1) {
        key = encodeURIComponent(key);
      }
      const value = `https://example.test/?${key}=encoded-name-secret`;
      expectRedacted(value, ["encoded-name-secret"]);
    }
  });
});
