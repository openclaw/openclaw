import { createPluginRuntimeProcessEntrypoint } from "openclaw/plugin-sdk/process-runtime";

export const codexStdioWorkerEntrypoint = createPluginRuntimeProcessEntrypoint(
  "codexStdio",
  import.meta.url,
);
