import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfigValue, resolveConfigValueUncached } from "./resolve-config-value.js";

const TEST_ENV_KEY = "OPENCLAW_RESOLVE_CONFIG_VALUE_TEST";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveConfigValue", () => {
  it.each([resolveConfigValue, resolveConfigValueUncached])(
    "does not use an explicitly empty environment variable as a credential",
    (resolve) => {
      vi.stubEnv(TEST_ENV_KEY, "");

      expect(resolve(TEST_ENV_KEY)).toBeUndefined();
    },
  );

  it.each([resolveConfigValue, resolveConfigValueUncached])(
    "keeps non-empty environment variables ahead of literal values",
    (resolve) => {
      vi.stubEnv(TEST_ENV_KEY, "configured-secret");

      expect(resolve(TEST_ENV_KEY)).toBe("configured-secret");
    },
  );

  it.each([resolveConfigValue, resolveConfigValueUncached])(
    "keeps absent environment names usable as literal values",
    (resolve) => {
      vi.stubEnv(TEST_ENV_KEY, undefined);

      expect(resolve(TEST_ENV_KEY)).toBe(TEST_ENV_KEY);
    },
  );
});
