import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";

function registerClickClackHttpRoutes(api: OpenClawPluginApi): void {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "registerClickClackHttpRoutes",
  });
  register(api);
}

export default defineBundledChannelEntry({
  id: "clickclack",
  name: "ClickClack",
  description: "ClickClack channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "clickClackPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setClickClackRuntime",
  },
  registerFull: registerClickClackHttpRoutes,
});
