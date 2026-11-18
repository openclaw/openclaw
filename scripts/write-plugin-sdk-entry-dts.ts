// CI and standalone SDK builds select only SDK roots from the canonical declaration inputs.
import fs from "node:fs";
import { listCacheFiles } from "./lib/build-artifact-cache.mts";
import { TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS } from "./lib/tsdown-config-groups.mts";
import { writeTsdownDeclarations } from "./lib/tsdown-declaration-writer.mts";
import { TSDOWN_DECLARATION_EXTENSIONS } from "./tsdown-build.mts";

await writeTsdownDeclarations(
  TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS,
  "tsdown-plugin-sdk",
  (root) =>
    // This subset owns flat SDK entries, never other groups' shared root chunks.
    listCacheFiles(
      root,
      [{ path: "dist/plugin-sdk", extensions: TSDOWN_DECLARATION_EXTENSIONS, recursive: false }],
      fs,
    ),
  "scripts/write-plugin-sdk-entry-dts.ts",
);
