import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

function registerTools(api: OpenClawPluginApi) {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "registerTools",
  });
  register(api);
}

function initEnv(api: OpenClawPluginApi) {
  const init = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "initEnv",
  });
  init(api);
}

function initLogger(api: OpenClawPluginApi) {
  const init = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "initLogger",
  });
  init(api);
}

export default defineBundledChannelEntry({
  id: "yuanbao",
  name: "YuanBao",
  description: "YuanBao channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "yuanbaoPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setYuanbaoRuntime",
  },
  registerFull(api) {
    initEnv(api);
    initLogger(api);
    registerTools(api);
  },
});
