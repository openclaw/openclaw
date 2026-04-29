/**
 * Telegram 渠道运行时状态管理模块
 * 提供 Telegram 运行时的全局状态存储和访问接口
 */

// 从插件 SDK 运行时存储模块导入创建插件运行时存储的函数
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

// 从运行时类型模块导出 Telegram 渠道运行时类型
export type { TelegramChannelRuntime, TelegramRuntime } from "./runtime.types.js";

// 从运行时类型模块导入 Telegram 运行时类型
import type { TelegramRuntime } from "./runtime.types.js";

// 使用 createPluginRuntimeStore 创建 Telegram 运行时存储
// 该存储用于在整个应用生命周期内保存和访问 Telegram 运行时状态
const {
  // 设置运行时状态的函数
  setRuntime: setTelegramRuntime,
  // 清除运行时状态的函数
  clearRuntime: clearTelegramRuntime,
  // 获取运行时状态的函数
  getRuntime: getTelegramRuntime,
} = createPluginRuntimeStore<TelegramRuntime>({
  // 插件 ID，用于标识这是 Telegram 插件的存储
  pluginId: "telegram",
  // 错误消息，当运行时未初始化时抛出
  errorMessage: "Telegram runtime not initialized",
});

// 导出清除运行时函数，供其他模块在需要重置状态时调用
export { clearTelegramRuntime };

// 导出获取运行时函数，供其他模块访问当前的 Telegram 运行时状态
export { getTelegramRuntime };

// 导出设置运行时函数，用于内部初始化运行时状态
export { setTelegramRuntime };
