import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
import type { PluginRuntime } from "openclaw/plugin-sdk/naverworks";

const { setRuntime: setNaverWorksRuntime, getRuntime: getNaverWorksRuntime } =
  createPluginRuntimeStore<PluginRuntime>("NAVER WORKS runtime not initialized");

export { getNaverWorksRuntime, setNaverWorksRuntime };
