import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { PLUGIN_ID, registerSentryMonitor } from "./src/register.js";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Sentry Monitor",
  description:
    "Forwards every error-bearing OpenClaw lifecycle event to Sentry: model calls, agent turns, tool calls, message deliveries, subagents, cron runs, and abnormal session terminations. Also captures node-level uncaught exceptions / unhandled rejections.",
  register: (api) => registerSentryMonitor(api),
});
