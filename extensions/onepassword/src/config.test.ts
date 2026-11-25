import fs from "node:fs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import { MAX_REGISTERED_ITEMS, parseOnePasswordConfig } from "./config.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as { configSchema: Record<string, unknown> };
const schemaAccepts = (value: unknown) =>
  validateJsonSchemaValue({
    schema: manifest.configSchema,
    cacheKey: "onepassword.manifest.config-schema",
    value,
  }).ok;
const parseItems = (items: Record<string, unknown>, vault = "Automation") =>
  parseOnePasswordConfig({ vault, items });
const token = (overrides: Record<string, unknown> = {}) => ({
  token: { item: "Token", ...overrides },
});

describe("parseOnePasswordConfig", () => {
  it("allows an empty plugin config for SecretRef-only use", () => {
    expect(schemaAccepts({})).toBe(true);
    expect(parseOnePasswordConfig({})).toBeUndefined();
    expect(
      parseOnePasswordConfig({ defaultPolicy: "approve", cacheTtlSeconds: 300 }),
    ).toBeUndefined();
    expect(schemaAccepts({ vault: "Automation" })).toBe(false);
    expect(schemaAccepts({ items: { token: { item: "Token" } } })).toBe(false);
  });

  it.each<[Record<string, unknown>, string, string?]>([
    [{ Bad_Slug: { item: "Token" } }, "Invalid 1Password item slug"],
    [token({ item: "--help" }), "must not start with a hyphen"],
    [token(), "vault must not start with a hyphen", "-Automation"],
    [token({ vault: "-Other" }), "token vault must not start with a hyphen"],
    [token({ field: "username,password" }), "field must not contain commas"],
  ])("rejects invalid registry input: %j (%s)", (items, message, vault) => {
    expect(() => parseItems(items, vault)).toThrow(message);
  });

  it("applies defaults and item overrides", () => {
    expect(
      parseItems({
        token: { item: "Token" },
        denied: { item: "Denied", vault: "Other", field: "password", policy: "deny" },
      }),
    ).toMatchObject({
      defaultPolicy: "approve",
      cacheTtlSeconds: 300,
      grantTtlHours: 720,
      opTimeoutMs: 15_000,
      items: {
        token: { vault: "Automation", field: "credential", policy: "approve" },
        denied: { vault: "Other", field: "password", policy: "deny" },
      },
    });
  });

  it("bounds listable registry metadata", () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_REGISTERED_ITEMS + 1 }, (_, index) => [
        `token-${index}`,
        { item: `Token ${index}` },
      ]),
    );
    expect(() => parseItems(tooMany)).toThrow(`at most ${MAX_REGISTERED_ITEMS}`);
    expect(() => parseItems(token({ description: "x".repeat(201) }))).toThrow("at most 200");
  });
});
