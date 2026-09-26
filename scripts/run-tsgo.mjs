import { runNodeCliShim } from "./lib/tsx-cli-shim.mjs";

await runNodeCliShim(import.meta.url, {
  implementation: "./run-tsgo.mts",
  failureTool: "tsgo",
  // The implementation must join its compiler group before releasing artifact ownership.
  terminationOwner: "implementation",
});
