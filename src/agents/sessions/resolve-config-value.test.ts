import { afterEach, expect, it, vi } from "vitest";
import { resolveConfigValue } from "./resolve-config-value.js";

const TEST_ENV_KEY = "OPENCLAW_RESOLVE_CONFIG_VALUE_TEST";

afterEach(() => {
  vi.unstubAllEnvs();
});

it.each([
  { name: "empty", value: "", expected: undefined },
  { name: "configured", value: "configured-secret", expected: "configured-secret" },
  { name: "absent", value: undefined, expected: TEST_ENV_KEY },
])("resolveConfigValue resolves $name environment values", ({ value, expected }) => {
  vi.stubEnv(TEST_ENV_KEY, value);
  expect(resolveConfigValue(TEST_ENV_KEY)).toBe(expected);
});
