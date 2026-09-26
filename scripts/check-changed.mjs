import { runTsxCliShim } from "./lib/tsx-cli-shim.mjs";

await runTsxCliShim(import.meta.url, {
  implementation: "./check-changed.mts",
  // The implementation must join active checks before the outer wrapper exits.
  terminationOwner: "implementation",
});
