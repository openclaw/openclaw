import { createRequire } from "module";
import os from "os";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

/**
 * Plugin version number
 */
let _pluginVersion = "";
/**
 * openclaw 版本号
 */
let _openclawVersion = "";

/**
 * 返回当前Plugin version number
 */
export const getPluginVersion = () => _pluginVersion;

/**
 * 返回当前 openclaw 版本号
 */
export const getOpenclawVersion = () => _openclawVersion;

/**
 * 返回当前操作系统
 */
export const getOperationSystem = () => os.type();

/**
 * 注册插件的时候初始化插件和 openclaw 版本号
 */
export const initEnv = (api: OpenClawPluginApi) => {
  _pluginVersion = api?.version || "";
  _openclawVersion = api?.config?.meta?.lastTouchedVersion || "";

  if (!_pluginVersion || !_openclawVersion) {
    legacyInitEnv();
  }
};

/**
 * 兜底方案
 * 基于安装在用户的 .openclaw/extensions/yuanbao Directory下，
 * 所以需要向上两级找到 package.json 和 openclaw.json
 */
const legacyInitEnv = () => {
  try {
    const _require = createRequire(import.meta.url);
    // 读取插件自身版本（构建产物在 dist/ws/get-env.js，向上两级为根Directory）
    const _pluginPkg = _require("../../../package.json") as { version: string };
    const _openclawJson = _require("../../../../../openclaw.json") as {
      meta: { lastTouchedVersion: string };
    };

    _pluginVersion = _pluginPkg.version;
    _openclawVersion = _openclawJson.meta.lastTouchedVersion;
  } catch {
    // 忽略这里的路径错误
  }
};
