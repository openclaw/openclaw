// Verifies the plugin manifest config schema matches runtime secret-input handling.
import fs from "node:fs";
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: JsonSchemaObject };

function validate(value: Record<string, unknown>) {
  return validateJsonSchemaValue({
    schema: manifest.configSchema,
    cacheKey: "xmemo-memory.manifest.config",
    value,
  });
}

describe("xmemo-memory manifest config schema", () => {
  it("accepts a plain string apiKey", () => {
    const result = validate({ apiKey: "xmemo_test_key" });
    expect(result.ok).toBe(true);
  });

  it("accepts a SecretRef object for apiKey", () => {
    const result = validate({
      apiKey: { source: "env", provider: "default", id: "XMEMO_KEY" },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a SecretRef object for the deprecated token alias", () => {
    const result = validate({
      token: { source: "file", provider: "default", id: "xmemo_token" },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a SecretRef-like object with a missing provider", () => {
    const result = validate({
      apiKey: { source: "env", id: "XMEMO_KEY" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects unsupported secret sources", () => {
    const result = validate({
      apiKey: { source: "vault", provider: "default", id: "XMEMO_KEY" },
    });
    expect(result.ok).toBe(false);
  });
});
