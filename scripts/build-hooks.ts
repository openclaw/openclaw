/**
 * Compile bundled hook handlers from TypeScript to JavaScript.
 *
 * The main tsdown build doesn't include hook handlers, so this script
 * compiles them separately with esbuild. Heavy/native dependencies are
 * marked external since they're already available in the main bundle.
 */

import { build } from "esbuild";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const HOOKS_SRC = join(ROOT, "src/hooks/bundled");
const HOOKS_DIST = join(ROOT, "dist/hooks/bundled");

const EXTERNAL_DEPS = [
  "@anthropic-ai/*",
  "openai",
  "grammy",
  "discord.js",
  "@slack/*",
  "playwright*",
  "@napi-rs/*",
  "node-llama-cpp",
];

async function buildHooks() {
  if (!existsSync(HOOKS_SRC)) {
    console.log("No bundled hooks directory found, skipping");
    return;
  }

  const hooks = readdirSync(HOOKS_SRC, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let built = 0;
  let failed = 0;

  for (const hook of hooks) {
    const entry = join(HOOKS_SRC, hook, "handler.ts");
    if (!existsSync(entry)) continue;

    try {
      mkdirSync(join(HOOKS_DIST, hook), { recursive: true });
      await build({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        outfile: join(HOOKS_DIST, hook, "handler.js"),
        external: EXTERNAL_DEPS,
        logLevel: "warning",
      });
      console.log(`✓ ${hook}`);
      built++;
    } catch (err) {
      console.error(`✗ ${hook}:`, err instanceof Error ? err.message : err);
      failed++;
    }
  }

  console.log(`\nHooks: ${built} built, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

buildHooks();
