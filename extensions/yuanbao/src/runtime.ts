/**
 * Runtime singleton storage module.
 * Uses SDK's createPluginRuntimeStore to manage PluginRuntime singleton.
 * During plugin registration, index.ts calls setYuanbaoRuntime to store the OpenClaw Runtime reference;
 * other modules (ws-gateway, etc.) retrieve it via getYuanbaoRuntime for core API calls (e.g. sending messages to AI agent).
 */
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setYuanbaoRuntime, getRuntime: getYuanbaoRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Yuanbao runtime not initialized");
export { getYuanbaoRuntime, setYuanbaoRuntime };
