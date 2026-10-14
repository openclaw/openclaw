import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { expect, it } from "vitest";
import { BuzzConfigSchema } from "./config-schema.js";

it("rejects prototype-sensitive account keys in runtime and generated schemas", () => {
  const runtime = BuzzConfigSchema.runtime;
  if (!runtime) {
    throw new Error("expected Buzz runtime config schema");
  }
  const accountConfig = {
    groupPolicy: "allowlist",
    accounts: { constructor: { relayUrl: "wss://buzz.example.com" } },
  };
  expect(runtime.safeParse(accountConfig).success).toBe(false);
  expect(
    validateJsonSchemaValue({
      cacheKey: "buzz.reserved-account",
      schema: BuzzConfigSchema.schema,
      value: accountConfig,
    }).ok,
  ).toBe(false);
  const defaultConfig = { groupPolicy: "allowlist", defaultAccount: "constructor" };
  expect(runtime.safeParse(defaultConfig).success).toBe(false);
  expect(
    validateJsonSchemaValue({
      cacheKey: "buzz.reserved-default-account",
      schema: BuzzConfigSchema.schema,
      value: defaultConfig,
    }).ok,
  ).toBe(false);
});
