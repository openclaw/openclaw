import { pathToFileURL } from "node:url";
import { copyBundledPluginMetadata } from "./copy-bundled-plugin-metadata.mjs";
import { copyPluginSdkRootAlias } from "./copy-plugin-sdk-root-alias.mjs";
import { stageBundledPluginRuntimeDeps } from "./stage-bundled-plugin-runtime-deps.mjs";
import { stageBundledPluginRuntime } from "./stage-bundled-plugin-runtime.mjs";
import { writeOfficialChannelCatalog } from "./write-official-channel-catalog.mjs";

export function runRuntimeMetadataPostBuild(params = {}) {
  copyPluginSdkRootAlias(params);
  copyBundledPluginMetadata(params);
  writeOfficialChannelCatalog(params);
}

export function runRuntimePostBuild(params = {}) {
  runRuntimeMetadataPostBuild(params);
  stageBundledPluginRuntimeDeps(params);
  stageBundledPluginRuntime(params);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runRuntimePostBuild();
}
