import { pathToFileURL } from "node:url";
import { copyBundledPluginMetadata } from "./copy-bundled-plugin-metadata.mjs";
import { copyMatrixCryptoWasmPkg } from "./copy-matrix-crypto-wasm-pkg.mjs";
import { copyPluginSdkRootAlias } from "./copy-plugin-sdk-root-alias.mjs";
import { stageBundledPluginRuntimeDeps } from "./stage-bundled-plugin-runtime-deps.mjs";
import { stageBundledPluginRuntime } from "./stage-bundled-plugin-runtime.mjs";
import { writeOfficialChannelCatalog } from "./write-official-channel-catalog.mjs";

export function runRuntimePostBuild(params = {}) {
  copyPluginSdkRootAlias(params);
  copyBundledPluginMetadata(params);
  copyMatrixCryptoWasmPkg(params);
  writeOfficialChannelCatalog(params);
  stageBundledPluginRuntimeDeps(params);
  stageBundledPluginRuntime(params);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runRuntimePostBuild();
}
