import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { resolveConfigValue, resolveConfigValueUncached } from "./resolve-config-value.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const TEST_ENV_KEY = "OPENCLAW_RESOLVE_CONFIG_VALUE_TEST";

afterEach(() => {
  vi.unstubAllEnvs();
});

it.each([
  { name: "empty", value: "", expected: undefined },
  { name: "configured", value: "configured-secret", expected: "configured-secret" },
  { name: "absent", value: undefined, expected: TEST_ENV_KEY },
])("resolveConfigValue resolves $name environment values", async ({ value, expected }) => {
  vi.stubEnv(TEST_ENV_KEY, value);
  expect(await resolveConfigValue(TEST_ENV_KEY)).toBe(expected);
});

it.each(["synthetic-key", ""])(
  "shares concurrent command work and preserves uncached reads (%s)",
  async (value) => {
    const root = tempDirs.make("config-command-");
    const counter = path.join(root, "count");
    const script = path.join(root, "credential.cjs");
    fs.writeFileSync(
      script,
      `const fs = require("node:fs");
const counter = ${JSON.stringify(counter)};
const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
fs.writeFileSync(counter, String(count + 1));
process.stdout.write(${JSON.stringify(value)});`,
    );
    const command = `!"${resolveTestNodeExecPath()}" "${script}"`;
    await expect(
      resolveConfigValue(command, () => {
        throw new Error("retired credential");
      }),
    ).rejects.toThrow("retired credential");
    expect(fs.existsSync(counter)).toBe(false);
    expect(await Promise.all([resolveConfigValue(command), resolveConfigValue(command)])).toEqual([
      value || undefined,
      value || undefined,
    ]);
    expect(fs.readFileSync(counter, "utf8")).toBe("1");
    expect(
      await Promise.all([resolveConfigValueUncached(command), resolveConfigValueUncached(command)]),
    ).toEqual([value || undefined, value || undefined]);
    expect(fs.readFileSync(counter, "utf8")).toBe("3");
  },
);
