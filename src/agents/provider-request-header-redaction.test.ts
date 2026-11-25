import { describe, expect, it } from "vitest";
import { redactProviderResponseErrorText as redact } from "./provider-request-header-redaction.js";

function mixPercentEscapeCase(value: string): string {
  let useLowerCase = true;
  return value.replace(/%[0-9A-F]{2}/gu, (escape) => {
    useLowerCase = !useLowerCase;
    return useLowerCase ? escape.toLowerCase() : escape;
  });
}

describe("provider request header redaction", () => {
  it("redacts decoded UTF-8 Basic credentials", () => {
    const password = "fixture-päss:word";
    const pair = `fixture-user:${password}`;
    const token = Buffer.from(pair, "utf8").toString("base64");
    const text = `pair=${pair} pass=${password} encoded=${encodeURIComponent(password)} user=fixture-user`;
    for (const header of ["Authorization", "Proxy-Authorization"]) {
      expect(redact(text, { [header]: `bAsIc ${token}` })).toBe(
        "pair=*** pass=*** encoded=*** user=fixture-user",
      );
    }
  });

  it.each([
    { headers: new Headers({ "X-Proxy-Auth": "opaque-credential" }) },
    { headers: [["X-Proxy-Auth", "opaque-credential"]] satisfies HeadersInit },
  ])("redacts credentials supplied through HeadersInit", ({ headers }) => {
    expect(redact("Rejected opaque-credential", headers)).toBe("Rejected ***");
  });

  it("redacts configured header values and bare authorization credentials", () => {
    const text =
      "content-type=application/json reflected=Bearer bearer-credential bearer-credential Basic proxy-credential proxy-credential custom-credential";
    const redacted = redact(text, {
      "Content-Type": "application/json",
      Authorization: "Bearer bearer-credential",
      "Proxy-Authorization": "Basic proxy-credential",
      "X-Proxy-Auth": "custom-credential",
    });

    expect(redacted).toBe("content-type=application/json reflected=*** *** *** *** ***");
  });

  it("redacts raw, JSON, URI, and form representations without rewriting unrelated escapes", () => {
    const secret = 'river +17/GLASS~MOTH%"tail';
    const uriEncoded = mixPercentEscapeCase(encodeURIComponent(secret));
    const formEncoded = mixPercentEscapeCase(
      new URLSearchParams([["value", secret]]).toString().slice("value=".length),
    );
    const jsonEncoded = JSON.stringify(secret).slice(1, -1);
    const text = `raw=${secret} json={"opaque":"${jsonEncoded}"} uri=${uriEncoded} form=${formEncoded} safe=id%2fpart keep%afcase`;
    expect(redact(text, { "X-Proxy-Auth": secret })).toBe(
      'raw=*** json={"opaque":"***"} uri=*** form=*** safe=id%2fpart keep%afcase',
    );
  });

  it.each([
    ["raw", "boundary-credential-secret", "boundary-credential-se"],
    ["URI", 'river +17/GLASS~MOTH%"tail', "river%20%2b17%2fGLASS~MOTH%25%22"],
    ["form", 'river +17/GLASS~MOTH%"tail', "river+%2b17%2fGLASS%7eMOTH%25%22"],
  ])("redacts a %s secret prefix only when the response was truncated", (_name, secret, prefix) => {
    const text = `safe id%afpart diagnostic ${prefix}`;
    const headers = { "X-Auth": secret, "X-Other": "another +% credential" };
    expect(redact(text, headers, { sourceTruncated: true })).toBe("safe id%afpart diagnostic ***");
    expect(redact(text, headers)).toBe(text);
  });

  it("redacts raw and JSON forms when a value contains a lone surrogate", () => {
    const secret = "lone-\ud800-surrogate-secret";
    const jsonEncoded = JSON.stringify(secret).slice(1, -1);
    expect(redact(`raw=${secret} json=${jsonEncoded}`, { "X-Auth": secret })).toBe(
      "raw=*** json=***",
    );
  });
});
