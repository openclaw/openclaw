import type { OpenClawPluginApi } from "openclaw/plugin-sdk/llm-task";
import { createChannelTool } from "./src/create-channel-tool.js";
import { getWeatherTool } from "./src/get-weather-tool.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool((ctx) => createChannelTool(api, ctx), { optional: false });
  api.registerTool((ctx) => getWeatherTool(api, ctx), { optional: false });
}
