import type { PluginRuntime } from "openclaw/plugin-sdk/msteams";
import { createPluginRuntimeStore } from "../../../src/plugin-sdk/runtime-store.js";

const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime } =
  createPluginRuntimeStore<PluginRuntime>("MSTeams runtime not initialized");
export { getMSTeamsRuntime, setMSTeamsRuntime };
