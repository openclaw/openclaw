import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { registerSecretValueForRedaction } from "../../../src/logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../../src/logging/secret-redaction-registry.test-support.js";

it("public security-runtime package preserves redaction options and credential protection", async () => {
  const { redactSensitiveText }: typeof import("@openclaw/plugin-sdk/security-runtime") =
    await import(createRequire(import.meta.url).resolve("@openclaw/plugin-sdk/security-runtime"));
  const matcher = {
    source: "fixture-note",
    *exec(input: string) {
      const match = "NOTE:fixture-gamma";
      for (
        let offset = input.indexOf(match);
        offset !== -1;
        offset = input.indexOf(match, offset + match.length)
      ) {
        yield { match, groups: ["NOTE", "fixture-gamma", ""], input, offset };
      }
    },
  };
  const patterns = [String.raw`/PIN:([^|]+)/g`, /REF:([^|]+)/, matcher];
  const text = "🙂 PIN:fixture-alpha| REF:fixture-beta| NOTE:fixture-gamma| NOTE:fixture-gamma|";
  for (let call = 0; call < 2; call++) {
    expect(redactSensitiveText(text, { patterns })).toBe(
      "🙂 PIN:***| REF:***| NOTE:***| NOTE:***|",
    );
  }

  const url = "https://x.com/EliXPampa/status/2097727549400871286";
  const secret = "Ab9Q".repeat(10);
  expect(redactSensitiveText(`${url} ${secret}`, {})).toBe(`${url} Ab9QAb…Ab9Q`);
  resetSecretRedactionRegistryForTest();
  try {
    registerSecretValueForRedaction("fixture-registered");
    expect(redactSensitiveText("fixture-registered", { patterns })).toBe("fixtur…ered");
    expect(redactSensitiveText(`${secret} fixture-registered`, { mode: "off" })).toBe(
      `${secret} fixtur…ered`,
    );
  } finally {
    resetSecretRedactionRegistryForTest();
  }
});
