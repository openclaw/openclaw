import { describe, expect, it } from "vitest";
import { configureAcpErrorRedactor, redactSensitiveText } from "./error-format.js";

function expectRedactedLines(input: string[], expected: string[]) {
  expect(redactSensitiveText(input.join("\n"))).toBe(expected.join("\n"));
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
    expectRedactedLines(
      [
        "Authorization: token samplevalue1234567890abcd",
        "Proxy-Authorization: Digest sampleproxyvalue1234567890",
        'Authorization: Digest username="digest-user-example", 2fa="digest-extension-1234567890abcdef", response="digest-response-1234567890abcdef", extension="digest-tail-1234567890abcdef", cnonce="tail-nonce"; request_id=digest-example',
        "Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE1234567890/20260717/eu-west-1/s3/aws4_request, SignedHeaders=:authority;x_custom;x.custom, Signature=aws-signature-1234567890abcdef; status=403",
        'Proxy-Authorization: Digest username="digest-user-example", response="digest-response-1234567890abcdef"; request_id=proxy-example',
        "api-key: samplekeyvalue1234567890",
        "x-goog-api-key=samplegoogvalue1234567890",
        "x-access-token: sampleaccessvalue1234567890",
      ],
      [
        "Authorization: token [REDACTED]",
        "Proxy-Authorization: Digest [REDACTED]",
        "Authorization: Digest [REDACTED]; request_id=digest-example",
        "Authorization: AWS4-HMAC-SHA256 [REDACTED]; status=403",
        "Proxy-Authorization: Digest [REDACTED]; request_id=proxy-example",
        "api-key: [REDACTED]",
        "x-goog-api-key=[REDACTED]",
        "x-access-token: [REDACTED]",
      ],
    );
  });

  it("redacts consecutive, prefixed, and serialized auth headers", () => {
    expectRedactedLines(
      [
        "Proxy-Authorization: Foo",
        "Proxy-Authorization: Basic cHJveHk6cGFzcw==",
        "X-Authorization: Basic Y3VzdG9tOnBhc3M=",
        JSON.stringify({
          "x-access-token": "sample-access-value-1234567890",
          "x-goog-api-key": "sample-google-value-1234567890",
        }),
      ],
      [
        "Proxy-Authorization: [REDACTED]",
        "Proxy-Authorization: Basic [REDACTED]",
        "X-Authorization: Basic [REDACTED]",
        JSON.stringify({
          "x-access-token": "[REDACTED]",
          "x-goog-api-key": "[REDACTED]",
        }),
      ],
    );
  });

  it("redacts later auth params and token credentials after punctuation", () => {
    const responseValue = "later-response-value-1234567890";
    const foldedValue = "Zm9sZGVkOnNlY3JldA==";
    expectRedactedLines(
      [
        `Authorization: Digest username="sample",,response="${responseValue}"; status=401`,
        `Authorization: Digest damaged,,response="${responseValue}"; status=403`,
        `Authorization: Digest username="sample", uri=/bad, response="${responseValue}"; status=407`,
        `Authorization: Digest username="sample",\r\n response="${responseValue}"; status=408`,
        `Authorization: Digest uri=http://service, response="${responseValue}"; status=409`,
        `Authorization: Digest response='${responseValue}'; status=410`,
        `Authorization: Digest realm=sample, authorization-param=${responseValue}; status=412`,
        `Authorization: Digest username=sample,\\r\\n response=${responseValue}; status=413`,
        `Authorization: Digest username=sample,\\r\\n\\tresponse=${responseValue}; status=414`,
        "(Authorization: Negotiate cHJvb2YxMjM0NTY3ODkw)",
        `Authorization:\r\n Basic ${foldedValue}`,
        `Authorization:\nBasic ${foldedValue}`,
        `Authorization:\\nBasic ${foldedValue}`,
        `Authorization:\\tBearer ${foldedValue}`,
        `Authorization: Bearer\\t${foldedValue}`,
        "Authorization: raw-header-value-1234567890   ",
      ],
      [
        ...[401, 403, 407, 408, 409, 410, 412, 413, 414].map(
          (code) => `Authorization: Digest [REDACTED]; status=${code}`,
        ),
        "(Authorization: Negotiate [REDACTED])",
        "Authorization:\r\n Basic [REDACTED]",
        "Authorization:\nBasic [REDACTED]",
        "Authorization:\\nBasic [REDACTED]",
        "Authorization:\\tBearer [REDACTED]",
        "Authorization: Bearer\\t[REDACTED]",
        "Authorization: [REDACTED]   ",
      ],
    );
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
    expectRedactedLines(
      [
        'Authorization: Hawk id="client", mac="hawk-credential-proof-1234567890abcdef"; status=401',
        `Authorization: Digest realm=\\"Example \\\\\\"Realm\\\\\\"\\", response=\\"escaped-quoted-response-1234567890abcdef\\"; status=403`,
      ],
      [
        "Authorization: Hawk [REDACTED]; status=401",
        "Authorization: Digest [REDACTED]; status=403",
      ],
    );
  });

  it("redacts full auth-param tokens and serialized header objects", () => {
    expectRedactedLines(
      [
        "Authorization: Foo id=abc'def`ghi, proof=token-grammar-proof-1234567890abcdef; status=401",
        `{"Authorization":"Digest username=\\"example\\", response=\\"json-digest-response-1234567890abcdef\\""}`,
      ],
      ["Authorization: Foo [REDACTED]; status=401", `{"Authorization":"[REDACTED]"}`],
    );
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
    expectRedactedLines(
      [
        "API_KEY=***-live-secret-1234567890abcdef",
        'Authorization: Digest ***ext=one, response="marker-digest-response-1234567890abcdef"; status=401',
      ],
      ["API_KEY=[REDACTED]", "Authorization: Digest [REDACTED]; status=401"],
    );
  });

  it("preserves marker-shaped input while redacting structured auth", () => {
    const markerZero = ";__openclaw_structured_auth_redacted_0;";
    const markerOne = ";__openclaw_structured_auth_redacted_1;";
    expectRedactedLines(
      [
        markerZero,
        markerOne,
        'Authorization: Digest response="collision-response-1234567890abcdef"; status=401',
      ],
      [markerZero, markerOne, "Authorization: Digest [REDACTED]; status=401"],
    );
  });

  it("preserves Basic padding diagnostics and masks punctuation in header values", () => {
    expectRedactedLines(
      ["Authorization: Basic dXNlcg==, status=401", "api-key: prefix)sensitive-suffix"],
      ["Authorization: Basic [REDACTED], status=401", "api-key: [REDACTED]"],
    );
  });

  it("redacts quoted diagnostics while preserving structural closers", () => {
    expectRedactedLines(
      [
        `curl -H 'Authorization: Digest username="example", response="quoted-header-response-1234567890abcdef"'`,
        "{Authorization: AWS4-HMAC-SHA256 Credential=scope/path, SignedHeaders=host, Signature=structural-aws-signature-1234567890abcdef}",
      ],
      [
        "curl -H 'Authorization: Digest [REDACTED]'",
        "{Authorization: AWS4-HMAC-SHA256 [REDACTED]}",
      ],
    );
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
