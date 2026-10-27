import { createPluginRuntimeProcessEntrypoint } from "openclaw/plugin-sdk/process-runtime";

export const codexHistoryWorkerEntrypoint = createPluginRuntimeProcessEntrypoint(
  "codexSessionHistory",
  import.meta.url,
);
