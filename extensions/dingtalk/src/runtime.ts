import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

// 必须使用 SDK 提供的 createPluginRuntimeStore（按 pluginId 走 globalThis
// 注册表），而不是把 runtimeValue 放在本模块作用域里。
//
// 原因：bundled channel entry 通过 `loadBundledEntryExportSync` 动态加载
// `runtime-api.js` 来调用 setRuntime，而 `core/message-handler.ts` 等模块是
// 通过静态 import 拿到 getRuntime。两条加载路径会得到两份独立的
// `src/runtime.ts` 模块实例 —— set 写入 A 实例、get 读的是 B 实例，导致
// 用户实际发消息时永远命中 "DingTalk runtime not initialized" 兜底分支，
// 群里看到 "抱歉，处理请求时出错: DingTalk runtime not initialized"。
//
// `createPluginRuntimeStore({ pluginId })` 把 slot 挂在 globalThis 的
// Symbol 注册表上，对多模块实例天然共享，与其它 channel 插件（feishu /
// discord / slack 等）保持一致。
const { setRuntime: setDingtalkRuntime, getRuntime: getDingtalkRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "dingtalk",
    errorMessage: "DingTalk runtime not initialized",
  });

export { getDingtalkRuntime, setDingtalkRuntime };
