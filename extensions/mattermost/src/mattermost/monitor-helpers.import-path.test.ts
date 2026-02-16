import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

describe("monitor-helpers dedupe implementation", () => {
  test("does not re-export createDedupeCache from plugin-sdk barrel", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const filePath = resolve(here, "./monitor-helpers.ts");
    const source = readFileSync(filePath, "utf8");

    expect(source).not.toContain('export { createDedupeCache } from "openclaw/plugin-sdk";');
  });
});
