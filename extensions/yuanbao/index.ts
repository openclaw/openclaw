import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/core";

/**
 * 通过 loadBundledEntryExportSync 懒加载注册工具
 */
function registerTools(api: OpenClawPluginApi): void {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "registerTools",
  });
  register(api);
}

/**
 * 通过 loadBundledEntryExportSync 懒加载注册升级命令
 */
function registerUpgradeCommands(api: OpenClawPluginApi): void {
  const yuanbaoUpgradeCommand = loadBundledEntryExportSync<OpenClawPluginCommandDefinition>(
    import.meta.url,
    { specifier: "./api.js", exportName: "yuanbaoUpgradeCommand" },
  );
  const yuanbaobotUpgradeCommand = loadBundledEntryExportSync<OpenClawPluginCommandDefinition>(
    import.meta.url,
    { specifier: "./api.js", exportName: "yuanbaobotUpgradeCommand" },
  );
  const logUploadCommandDefinition = loadBundledEntryExportSync<OpenClawPluginCommandDefinition>(
    import.meta.url,
    { specifier: "./api.js", exportName: "logUploadCommandDefinition" },
  );

  api.registerCommand(yuanbaoUpgradeCommand);
  api.registerCommand(yuanbaobotUpgradeCommand);
  api.registerCommand(logUploadCommandDefinition);
}

/**
 * 通过 loadBundledEntryExportSync 懒加载初始化内置表情缓存
 */
function initBuiltinStickers(): void {
  const init = loadBundledEntryExportSync<() => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "initBuiltinStickers",
  });
  init();
}

/**
 * 通过 loadBundledEntryExportSync 懒加载初始化Environment variables
 */
function initEnv(api: OpenClawPluginApi): void {
  const init = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "initEnv",
  });
  init(api);
}

/**
 * 通过 loadBundledEntryExportSync 懒加载初始化日志
 */
function initLogger(api: OpenClawPluginApi): void {
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
  registerFull(api: OpenClawPluginApi) {
    initEnv(api);
    initLogger(api);

    // 注册所有工具（内部按类别分组管理）
    registerTools(api);

    // 注册升级命令（Owner 校验在 inbound.ts 中通过 bot_owner_id 完成）
    registerUpgradeCommands(api);

    // 初始化内置表情缓存（首次写入后不会覆盖 received 来源的条目）
    initBuiltinStickers();
  },
});
