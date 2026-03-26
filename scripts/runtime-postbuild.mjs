import { pathToFileURL } from "node:url";
import { copyBundledPluginMetadata } from "./copy-bundled-plugin-metadata.mjs";
import { copyPluginSdkRootAlias } from "./copy-plugin-sdk-root-alias.mjs";
import { patchMSTeamsHttpPluginApiRoute } from "./patch-msteams-httpplugin-route.mjs";
import { stageBundledPluginRuntimeDeps } from "./stage-bundled-plugin-runtime-deps.mjs";
import { stageBundledPluginRuntime } from "./stage-bundled-plugin-runtime.mjs";
import { writeOfficialChannelCatalog } from "./write-official-channel-catalog.mjs";

export function runRuntimePostBuild(params = {}) {
  copyPluginSdkRootAlias(params);
  copyBundledPluginMetadata(params);
  writeOfficialChannelCatalog(params);
  stageBundledPluginRuntimeDeps(params);
  stageBundledPluginRuntime(params);

  // The Teams SDK's HttpPlugin registers an Express route pattern of "/api*".
  // That pattern is rejected by newer path-to-regexp versions (Express v5),
  // causing the Teams channel to crash at startup.
  //
  // Patch the emitted runtime bundle to use the stable Express prefix mount.
  patchMSTeamsHttpPluginApiRoute(params);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runRuntimePostBuild();
}
