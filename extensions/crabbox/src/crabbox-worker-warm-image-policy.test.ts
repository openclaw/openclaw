import fs from "node:fs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import { resolveCrabboxWarmImagePolicy } from "./crabbox-worker-warm-image-policy.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as { configSchema: Record<string, unknown> };

function validate(value: unknown) {
  return validateJsonSchemaValue({
    schema: manifest.configSchema,
    cacheKey: "crabbox.warm-image-policy",
    value,
  });
}

describe("Crabbox warm image retention policy", () => {
  it("preserves the existing default refresh and unused retention windows", () => {
    expect(validate({}).ok).toBe(true);
    expect(resolveCrabboxWarmImagePolicy()).toEqual({
      refreshAfterMs: 86_400_000,
      retainUnusedMs: 1_209_600_000,
      keepPrevious: 0,
    });
  });

  it.each([
    ["60m", "1440m", 3_600_000, 86_400_000],
    ["90m", "24h", 5_400_000, 86_400_000],
    ["2h", "2d", 7_200_000, 172_800_000],
    ["99999999d", "99999999d", 8_639_999_913_600_000, 8_639_999_913_600_000],
  ])(
    "accepts bounded policy durations %s / %s",
    (refreshAfter, retainUnused, refreshAfterMs, retainUnusedMs) => {
      const config = { warmImages: { refreshAfter, retainUnused, keepPrevious: 1 } };
      expect(validate(config).ok).toBe(true);
      expect(resolveCrabboxWarmImagePolicy(config)).toEqual({
        refreshAfterMs,
        retainUnusedMs,
        keepPrevious: 1,
      });
    },
  );

  it.each([
    { refreshAfter: "59m" },
    { refreshAfter: "0h" },
    { refreshAfter: "1h30m" },
    { refreshAfter: "1.5h" },
    { refreshAfter: " 1h" },
    { refreshAfter: "24h\n" },
    { refreshAfter: "24h\r" },
    { refreshAfter: "24h\u2028" },
    { retainUnused: "14d\n" },
    { retainUnused: "14d\r\n" },
    { retainUnused: "14d\u2029" },
    { refreshAfter: "100000000d" },
    { refreshAfter: 3600000 },
    { retainUnused: "23h" },
    { retainUnused: "1439m" },
    { retainUnused: "0d" },
    { keepPrevious: 2 },
    { keepPrevious: "1" },
    { keepPrevious: null },
  ])(
    "rejects invalid config at both config validation and plugin registration: %j",
    (warmImages) => {
      const config = { warmImages };
      expect(validate(config).ok).toBe(false);
      expect(() => resolveCrabboxWarmImagePolicy(config)).toThrow("Crabbox warmImages.");
    },
  );

  it.each([{ warmImages: null }, { warmImages: "24h" }, { warmImages: { typo: "1h" } }])(
    "rejects malformed or unknown policy keys before plugin loading: %j",
    (config) => expect(validate(config).ok).toBe(false),
  );
});
