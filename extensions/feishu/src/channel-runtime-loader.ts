import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";

// Loads the Feishu channel runtime barrel on first use so the plugin entry and the
// action/topic-anchor paths keep a light static import graph; every send and anchor
// path shares this one loader.
export const loadFeishuChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "feishuChannelRuntime",
);
