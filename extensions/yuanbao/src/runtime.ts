/**
 * Runtime单例存储模块
 * 使用 SDK 官方 createPluginRuntimeStore 管理 PluginRuntime 单例，
 * 在插件注册阶段由 index.ts 调用 setYuanbaoRuntime 保存 OpenClaw Runtime引用，
 * 其他模块（ws-gateway 等）通过 getYuanbaoRuntime 获取，用于调用核心 API（如发送消息给 AI agent）
 */
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setYuanbaoRuntime, getRuntime: getYuanbaoRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Yuanbao runtime not initialized");
export { getYuanbaoRuntime, setYuanbaoRuntime };
