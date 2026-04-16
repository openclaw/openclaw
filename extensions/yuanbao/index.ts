import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

/** 懒加载注册工具 */
function registerTools(api: OpenClawPluginApi) {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "registerTools",
  });
  register(api);
}

/** 懒加载注册升级命令 */
function registerUpgradeCommands(api: OpenClawPluginApi) {
  const yuanbaoUpgradeCommand = loadBundledEntryExportSync<Parameters<OpenClawPluginApi["registerCommand"]>[0]>(
    import.meta.url,
    { specifier: "./api.js", exportName: "yuanbaoUpgradeCommand" },
  );
  const yuanbaobotUpgradeCommand = loadBundledEntryExportSync<Parameters<OpenClawPluginApi["registerCommand"]>[0]>(
    import.meta.url,
    { specifier: "./api.js", exportName: "yuanbaobotUpgradeCommand" },
  );
  const logUploadCommandDefinition = loadBundledEntryExportSync<Parameters<OpenClawPluginApi["registerCommand"]>[0]>(
    import.meta.url,
    { specifier: "./api.js", exportName: "logUploadCommandDefinition" },
  );

  api.registerCommand(yuanbaoUpgradeCommand);
  api.registerCommand(yuanbaobotUpgradeCommand);
  api.registerCommand(logUploadCommandDefinition);
}

/** 懒加载初始化内置表情缓存 */
function initBuiltinStickers() {
  const init = loadBundledEntryExportSync<() => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "initBuiltinStickers",
  });
  init();
}

/** 懒加载初始化环境变量 */
function initEnv(api: OpenClawPluginApi) {
  const init = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "initEnv",
  });
  init(api);
}

/** 懒加载初始化日志 */
function initLogger(api: OpenClawPluginApi) {
  const init = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "initLogger",
  });
  init(api);
}

/** 懒加载注册生命周期 hook */
function registerHooks(api: OpenClawPluginApi) {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "registerYuanbaoHooks",
  });
  register(api);
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

    // 注册所有工具（内部按类别分组管理）
    registerTools(api);

    // 注册升级命令（Owner 校验在 inbound.ts 中通过 bot_owner_id 完成）
    registerUpgradeCommands(api);

    // 初始化内置表情缓存（首次写入后不会覆盖 received 来源的条目）
    initBuiltinStickers();

    // 统一注册所有生命周期 hook（内部按事件类型分模块管理）
    registerHooks(api);
  },
});
