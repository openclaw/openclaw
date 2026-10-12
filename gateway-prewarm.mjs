import { flushCompileCache } from "node:module";
import { fileURLToPath } from "node:url";
import {
  enableOpenClawCompileCache,
  resolveOpenClawCompileCacheDirectory,
  resolveOpenClawCompileCacheRespawnEnv,
} from "./node-compile-cache.mjs";

const directory = resolveOpenClawCompileCacheDirectory({
  installRoot: fileURLToPath(new URL(".", import.meta.url)),
});
const respawnEnv = resolveOpenClawCompileCacheRespawnEnv({ directory });
if (respawnEnv) {
  const { runRespawnedChild } = await import("./node-runtime-recovery.mjs");
  await runRespawnedChild(process.execPath, [fileURLToPath(import.meta.url)], respawnEnv);
} else if (directory) {
  enableOpenClawCompileCache({ directory });
  // Import only: do not start a Gateway or read its configuration/state.
  await import("./dist/gateway-prewarm.js");
  flushCompileCache();
}
