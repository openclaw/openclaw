import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { genparkPlugin } from "./src/channel.ts";
import { setGenParkRuntime } from "./src/runtime.ts";

export { genparkPlugin } from "./src/channel.ts";
export { setGenParkRuntime } from "./src/runtime.ts";

export default defineChannelPluginEntry({
  id: "genpark",
  name: "GenPark",
  description: "Official GenPark Marketplace and Circle integration",
  plugin: genparkPlugin as ChannelPlugin,
  setRuntime: setGenParkRuntime,
});
