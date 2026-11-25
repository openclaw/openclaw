import { runBundledPluginAssetHooks } from "./bundled-plugin-assets.mts";

// Only release packagers stage assets. The installed self-update inventory writer stays independent.
export async function preparePackagedPluginAssets(rootDir: string): Promise<void> {
  await runBundledPluginAssetHooks({ phase: "package", rootDir });
}
