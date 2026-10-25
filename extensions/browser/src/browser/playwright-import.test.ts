import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);

it("loads Playwright without replacing process directory functions", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
await import("node:worker_threads");
const before = { cwd: process.cwd, chdir: process.chdir };
const playwright = createRequire(import.meta.url)(${JSON.stringify(require.resolve("playwright-core"))});
assert.equal(process.cwd, before.cwd);
assert.equal(process.chdir, before.chdir);
assert.equal(playwright.chromium.name(), "chromium");
const originalDirectory = process.cwd();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-import-"));
try {
  process.chdir(temporary);
  fs.writeFileSync("relative.txt", "relative file access");
  assert.equal(fs.readFileSync("relative.txt", "utf8"), "relative file access");
  assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(temporary));
} finally {
  process.chdir(originalDirectory);
  fs.rmSync(temporary, { recursive: true, force: true });
}
console.log("playwright import and relative file access passed");`,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(output.trim()).toBe("playwright import and relative file access passed");
});
