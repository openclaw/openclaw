#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pluginDir, "../..");
const outfile = path.join(pluginDir, "chrome-extension", "modules", "copilot-runtime.js");

await build({
  entryPoints: [path.join(pluginDir, "scripts", "copilot-runtime-entry.ts")],
  outfile,
  bundle: true,
  format: "esm",
  legalComments: "inline",
  minify: true,
  platform: "browser",
  target: "chrome125",
  tsconfig: path.join(repoRoot, "tsconfig.json"),
  banner: {
    js: `/* oxlint-disable eslint/constructor-super, eslint/curly, eslint/default-param-last, eslint/no-implicit-coercion, eslint/no-param-reassign, eslint/no-return-assign, eslint/no-sequences, eslint/no-underscore-dangle, eslint/no-unused-expressions, eslint/no-unused-vars, eslint/no-useless-assignment, eslint/no-var, eslint/prefer-const, typescript/consistent-return, typescript/no-misused-promises, typescript/prefer-promise-reject-errors, typescript/use-unknown-in-catch-callback-variable, unicorn/no-array-reverse -- generated bundle; lint the TypeScript source instead. */`,
  },
});
