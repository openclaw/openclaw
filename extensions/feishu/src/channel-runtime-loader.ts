import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";

// Loads the Feishu channel runtime barrel on first use so the plugin entry keeps a light
// static import graph; every send/anchor path shares this one loader.
export const loadFeishuChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "feishuChannelRuntime",
);
