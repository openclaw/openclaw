import { createPluginRuntimeProcessEntrypoint } from "openclaw/plugin-sdk/process-runtime";

export const memoryStatsRuntimeEntrypoint = createPluginRuntimeProcessEntrypoint(
  "memoryStatsRuntime",
  import.meta.url,
);
