import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "../../src/plugins/schema-validator.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: Record<string, unknown> };

describe("a2a-broker-adapter manifest config schema", () => {
  it("accepts explicit broker activation config with requester headers and secret refs", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "a2a-broker-adapter.manifest.explicit-activation",
      value: {
        baseUrl: "https://broker.example.com",
        edgeSecret: { secretRef: "secrets.a2a.edgeSecret" },
        requester: {
          id: "openclaw-main",
          kind: "service",
          role: "hub",
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects non-http broker base URLs", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "a2a-broker-adapter.manifest.bad-base-url",
      value: {
        baseUrl: "ssh://broker.example.com",
      },
    });

    expect(result.ok).toBe(false);
  });
});
