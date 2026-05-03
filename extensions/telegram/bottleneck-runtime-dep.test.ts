import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readPackageJson(relativePath: string): {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relativePath), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
}

function collectRuntimeDeps(packageJson: {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}): Map<string, string> {
  return new Map([
    ...Object.entries(packageJson.dependencies ?? {}),
    ...Object.entries(packageJson.optionalDependencies ?? {}),
  ]);
}

describe("telegram bundled channel runtime deps", () => {
  // The bundled telegram channel re-exports `apiThrottler` from
  // `@grammyjs/transformer-throttler` (see extensions/telegram/src/bot.runtime.ts).
  // That module's CommonJS shim does `require("bottleneck")`. When openclaw is
  // installed via `npm install -g openclaw`, npm's hoisting/dedup decisions can
  // place the throttler under `node_modules/openclaw/node_modules/...` without
  // also installing bottleneck where it can be resolved, leaving the channel
  // failing to load with `Cannot find module 'bottleneck'` at gateway start.
  //
  // The durable fix is to list `bottleneck` directly in the openclaw root
  // package.json `dependencies`, matching the same staged-runtime-deps approach
  // used for other transitive runtime peers shipped by bundled plugins. This
  // test guards against regressing on that staging.
  it("lists bottleneck in openclaw's root dependencies", () => {
    const rootPackageJson = readPackageJson("package.json");
    const rootDeps = collectRuntimeDeps(rootPackageJson);

    expect(rootDeps.get("@grammyjs/transformer-throttler")).toBeDefined();
    expect(rootDeps.has("bottleneck")).toBe(true);
  });
});
