import { createPluginRuntimeProcessEntrypoint } from "openclaw/plugin-sdk/process-runtime";

export const memoryCpuProcessEntrypoints = {
  search: createPluginRuntimeProcessEntrypoint("memorySearch", import.meta.url),
  index: createPluginRuntimeProcessEntrypoint("memoryIndex", import.meta.url),
  publication: createPluginRuntimeProcessEntrypoint("memoryPublication", import.meta.url),
  standingIntents: createPluginRuntimeProcessEntrypoint("memoryStandingIntents", import.meta.url),
  entryOrigins: createPluginRuntimeProcessEntrypoint("memoryEntryOrigins", import.meta.url),
} as const;
