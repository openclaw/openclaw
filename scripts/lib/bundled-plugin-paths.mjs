export const BUNDLED_PLUGIN_ROOT_DIR = "extensions";
export const BUNDLED_PLUGIN_PATH_PREFIX = `${BUNDLED_PLUGIN_ROOT_DIR}/`;
export const BUNDLED_PLUGIN_TEST_GLOB = `${BUNDLED_PLUGIN_ROOT_DIR}/**/*.test.ts`;
export const BUNDLED_PLUGIN_E2E_TEST_GLOB = `${BUNDLED_PLUGIN_ROOT_DIR}/**/*.e2e.test.ts`;
export const BUNDLED_PLUGIN_LIVE_TEST_GLOB = `${BUNDLED_PLUGIN_ROOT_DIR}/**/*.live.test.ts`;

export function bundledPluginRoot(pluginId) {
  return `${BUNDLED_PLUGIN_PATH_PREFIX}${pluginId}`;
}

export function bundledPluginFile(pluginId, relativePath) {
  return `${bundledPluginRoot(pluginId)}/${relativePath}`;
}

export function bundledDistPluginRoot(pluginId) {
  return `dist/${bundledPluginRoot(pluginId)}`;
}

export function bundledDistPluginFile(pluginId, relativePath) {
  return `${bundledDistPluginRoot(pluginId)}/${relativePath}`;
}

export function bundledPluginCallsite(pluginId, relativePath, line) {
  return `${bundledPluginFile(pluginId, relativePath)}:${line}`;
}
