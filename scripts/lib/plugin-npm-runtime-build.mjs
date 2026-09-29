import { runTsxCliShim } from "./tsx-cli-shim.mjs";

await runTsxCliShim(import.meta.url, {
  failureTool: "plugin-npm-runtime-build",
  implementation: "./plugin-npm-runtime-build.mts",
});
