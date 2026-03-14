import type { PluginRuntime } from "openclaw/plugin-sdk/telegram";
import { createPluginRuntimeStore } from "../../../src/plugin-sdk/runtime-store.js";

const { setRuntime: setTelegramRuntime, getRuntime: getTelegramRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Telegram runtime not initialized");
export { getTelegramRuntime, setTelegramRuntime };
