/**
 * 定义插件入口点
 * 从 openclaw/plugin-sdk/plugin-entry 模块导入插件定义函数
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
/**
 * 从当前目录的 register.runtime.js 导入 Anthropic 插件注册函数
 */
import { registerAnthropicPlugin } from "./register.runtime.js";

/**
 * 使用 definePluginEntry 定义插件的入口配置
 * 这是一个默认导出的插件配置对象
 */
export default definePluginEntry({
  // 插件的唯一标识符
  id: "anthropic",
  // 插件的显示名称
  name: "Anthropic Provider",
  // 插件的描述信息
  description: "Bundled Anthropic provider plugin",
  /**
   * 注册函数，在插件被加载时调用
   * @param api - OpenClaw 插件 API 对象，提供注册各种插件组件的方法
   * @returns 调用 registerAnthropicPlugin 返回的结果
   */
  register(api) {
    return registerAnthropicPlugin(api);
  },
});
