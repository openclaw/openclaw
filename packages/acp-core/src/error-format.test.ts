import { describe, expect, it } from "vitest";
import { configureAcpErrorRedactor, redactSensitiveText } from "./error-format.js";

// Mark the exact sensitive spans; keep all surrounding diagnostic bytes unchanged.
function expectRedactedLines(lines: string[]) {
  const fixture = lines.join("\n");
  const spans = /<secret>(.*?)<\/secret>/gs;
  expect(redactSensitiveText(fixture.replace(spans, "$1"))).toBe(
    fixture.replace(spans, "[REDACTED]"),
  );
}
const nested = (headers: Record<string, string>) => JSON.stringify(JSON.stringify(headers));
describe("redactSensitiveText", () => {
  it("applies fallback secret redaction after a configured redactor", () => {
    configureAcpErrorRedactor((value) => value.replace("prefix", "host-redacted"));
    try {
      expect(redactSensitiveText("prefix TOKEN=standalone-secret")).toBe(
        "host-redacted TOKEN=[REDACTED]",
      );
    } finally {
      configureAcpErrorRedactor(undefined);
    }
  });

  it("redacts unquoted auth-style HTTP headers in fallback errors", () => {
    expectRedactedLines([
      "Authorization: token <secret>samplevalue1234567890abcd</secret>",
      "Proxy-Authorization: Digest <secret>sampleproxyvalue1234567890</secret>",
      'Authorization: Digest <secret>username="digest-user-example", 2fa="digest-extension-1234567890abcdef", response="digest-response-1234567890abcdef", extension="digest-tail-1234567890abcdef", cnonce="tail-nonce"</secret>; request_id=digest-example',
      "Authorization: AWS4-HMAC-SHA256 <secret>Credential=AKIAEXAMPLE1234567890/20260717/eu-west-1/s3/aws4_request, SignedHeaders=:authority;x_custom;x.custom, Signature=aws-signature-1234567890abcdef</secret>; status=403",
      'Proxy-Authorization: Digest <secret>username="digest-user-example", response="digest-response-1234567890abcdef"</secret>; request_id=proxy-example',
      "api-key: <secret>samplekeyvalue1234567890</secret>",
      "x-goog-api-key=<secret>samplegoogvalue1234567890</secret>",
      "x-access-token: <secret>sampleaccessvalue1234567890</secret>",
    ]);
  });

  it("redacts consecutive, prefixed, and serialized auth headers", () => {
    expectRedactedLines([
      "Proxy-Authorization: <secret>Foo</secret>",
      "Proxy-Authorization: Basic <secret>cHJveHk6cGFzcw==</secret>",
      "X-Authorization: Basic <secret>Y3VzdG9tOnBhc3M=</secret>",
      JSON.stringify({
        "x-access-token": "<secret>sample-access-value-1234567890</secret>",
        "x-goog-api-key": "<secret>sample-google-value-1234567890</secret>",
      }),
    ]);
  });

  it("redacts later auth params and token credentials after punctuation", () => {
    const responseValue = "later-response-value-1234567890";
    const foldedValue = "Zm9sZGVkOnNlY3JldA==";
    expectRedactedLines([
      `Authorization: Digest <secret>username="sample",,response="${responseValue}"</secret>; status=401`,
      `Authorization: Digest <secret>damaged,,response="${responseValue}"</secret>; status=403`,
      `Authorization: Digest <secret>username="sample", uri=/bad, response="${responseValue}"</secret>; status=407`,
      `Authorization: Digest <secret>username="sample",\r\n response="${responseValue}"</secret>; status=408`,
      `Authorization: Digest <secret>uri=http://service, response="${responseValue}"</secret>; status=409`,
      `Authorization: Digest <secret>response='${responseValue}'</secret>; status=410`,
      `Authorization: Digest <secret>realm=sample, authorization-param=${responseValue}</secret>; status=412`,
      `Authorization: Digest <secret>username=sample,\\r\\n response=${responseValue}</secret>; status=413`,
      `Authorization: Digest <secret>username=sample,\\r\\n\\tresponse=${responseValue}</secret>; status=414`,
      "(Authorization: Negotiate <secret>cHJvb2YxMjM0NTY3ODkw</secret>)",
      `Authorization:\r\n Basic <secret>${foldedValue}</secret>`,
      `Authorization:\nBasic <secret>${foldedValue}</secret>`,
      `Authorization:\\nBasic <secret>${foldedValue}</secret>`,
      `Authorization:\\tBearer <secret>${foldedValue}</secret>`,
      `Authorization: Bearer\\t<secret>${foldedValue}</secret>`,
      "Authorization: <secret>raw-header-value-1234567890</secret>   ",
    ]);
    const serializedLine = JSON.stringify(
      `prefix\nAuthorization: Digest response="${responseValue}"`,
    );
    expect(redactSensitiveText(serializedLine)).toBe(
      JSON.stringify("prefix\nAuthorization: Digest [REDACTED]"),
    );
  });

  it("bounds recovery between repeated malformed auth headers", () => {
    const response = "final-response-1234567890abcdef";
    const malformed = Array.from({ length: 128 }, () => "Authorization: Digest damaged").join(" ");
    const output = redactSensitiveText(
      `${malformed} Authorization: Digest response="${response}"; status=411`,
    );
    expect(output).not.toContain(response);
    expect(output).toContain("Authorization: Digest [REDACTED]; status=411");
  });

  it("redacts parameterized schemes and encoded quoted-pairs", () => {
    expectRedactedLines([
      'Authorization: Hawk <secret>id="client", mac="hawk-credential-proof-1234567890abcdef"</secret>; status=401',
      `Authorization: Digest <secret>realm=\\"Example \\\\\\"Realm\\\\\\"\\", response=\\"escaped-quoted-response-1234567890abcdef\\"</secret>; status=403`,
    ]);
  });

  it("redacts full auth-param tokens and serialized header objects", () => {
    expectRedactedLines([
      "Authorization: Foo <secret>id=abc'def`ghi, proof=token-grammar-proof-1234567890abcdef</secret>; status=401",
      `{"Authorization":"<secret>Digest username=\\"example\\", response=\\"json-digest-response-1234567890abcdef\\"</secret>"}`,
    ]);
  });

  it("redacts nested serialized headers and punctuated token schemes", () => {
    const header = {
      Authorization: 'Digest response="nested-digest-response-1234567890abcdef\\\\"',
    };
    const token = "extension-token-1234567890abcdef";
    const bearerCredential = "/opaque-~bearer-1234567890abcdef";
    const opaqueCredential = "opaque-credential-1234567890abcdef";
    expect(
      [
        nested(header),
        JSON.stringify(header),
        `Authorization: Foo+Bar ${token}; status=401`,
        `Authorization: Basic+Foo ${token}; status=401`,
        nested({ Authorization: "Basic dXNlcjpwYXNz" }),
        `Authorization: Bearer ${bearerCredential}`,
        `request failed: Bearer ${bearerCredential}`,
        nested({ Authorization: `Bearer ${bearerCredential}` }),
        nested({ Authorization: opaqueCredential, "Proxy-Authorization": opaqueCredential }),
      ].map(redactSensitiveText),
    ).toEqual([
      nested({ Authorization: "Digest [REDACTED]" }),
      JSON.stringify({ Authorization: "[REDACTED]" }),
      "Authorization: Foo+Bar [REDACTED]; status=401",
      "Authorization: Basic+Foo [REDACTED]; status=401",
      nested({ Authorization: "Basic [REDACTED]" }),
      "Authorization: Bearer [REDACTED]",
      "request failed: Bearer [REDACTED]",
      nested({ Authorization: "Bearer [REDACTED]" }),
      nested({ Authorization: "[REDACTED]", "Proxy-Authorization": "[REDACTED]" }),
    ]);
  });

  it("does not confuse real marker prefixes with internal redaction state", () => {
    expectRedactedLines([
      "API_KEY=<secret>***-live-secret-1234567890abcdef</secret>",
      'Authorization: Digest <secret>***ext=one, response="marker-digest-response-1234567890abcdef"</secret>; status=401',
    ]);
  });

  it("preserves marker-shaped input while redacting structured auth", () => {
    expectRedactedLines([
      ";__openclaw_structured_auth_redacted_0;",
      ";__openclaw_structured_auth_redacted_1;",
      'Authorization: Digest <secret>response="collision-response-1234567890abcdef"</secret>; status=401',
    ]);
  });

  it("preserves Basic padding diagnostics and masks punctuation in header values", () => {
    expectRedactedLines([
      "Authorization: Basic <secret>dXNlcg==</secret>, status=401",
      "api-key: <secret>prefix)sensitive-suffix</secret>",
    ]);
  });

  it("redacts quoted diagnostics while preserving structural closers", () => {
    expectRedactedLines([
      `curl -H 'Authorization: Digest <secret>username="example", response="quoted-header-response-1234567890abcdef"</secret>'`,
      "{Authorization: AWS4-HMAC-SHA256 <secret>Credential=scope/path, SignedHeaders=host, Signature=structural-aws-signature-1234567890abcdef</secret>}",
    ]);
  });

  it("keeps diagnostics adjacent to single-token auth headers", () => {
    const keyHeader = ["api", "-", "key"].join("");
    const token = ["opaque", "auth", "value", "1234567890abcdef"].join("-");
    const input = [
      `Authorization: ${token}, status=401`,
      `Proxy-Authorization: ${token}; request_id=example`,
      `${keyHeader}: ${token}, status=500`,
    ].join("\n");

    expect(redactSensitiveText(input)).toBe(
      [
        "Authorization: [REDACTED], status=401",
        "Proxy-Authorization: [REDACTED]; request_id=example",
        `${keyHeader}: [REDACTED], status=500`,
      ].join("\n"),
    );
  });

  it("keeps diagnostics adjacent to scheme-token auth headers", () => {
    const token = ["scheme", "auth", "value", "1234567890abcdef"].join("-");
    const input = [
      `Authorization: Token ${token}, status=401`,
      `Proxy-Authorization: Basic ${token}; request_id=example`,
    ].join("\n");

    expect(redactSensitiveText(input)).toBe(
      [
        "Authorization: Token [REDACTED], status=401",
        "Proxy-Authorization: Basic [REDACTED]; request_id=example",
      ].join("\n"),
    );
  });

  it("does not redact ordinary authorization prose in fallback errors", () => {
    const input = "the authorization model is open";

    expect(redactSensitiveText(input)).toBe(input);
  });
});
