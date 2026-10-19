import path from "node:path";
import { fileURLToPath } from "node:url";
import { setManagedCodexPluginRoot } from "./src/app-server/managed-binary.js";
import { buildCodexMigrationProvider } from "./src/migration/provider.js";

// Explicit migration loads this artifact without registering the full harness.
export function buildMigrationProvider(params?: Parameters<typeof buildCodexMigrationProvider>[0]) {
  setManagedCodexPluginRoot(path.dirname(fileURLToPath(import.meta.url)));
  return buildCodexMigrationProvider(params);
}
