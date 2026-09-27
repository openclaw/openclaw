import { runTsxCliShim } from "./lib/tsx-cli-shim.mjs";

await runTsxCliShim(import.meta.url, {
  implementation: "./ci-codex-test-selection.mts",
});
