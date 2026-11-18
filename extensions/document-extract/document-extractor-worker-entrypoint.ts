import { createPluginRuntimeProcessEntrypoint } from "openclaw/plugin-sdk/process-runtime";

export const documentExtractorWorkerEntrypoint = createPluginRuntimeProcessEntrypoint(
  "documentExtractor",
  import.meta.url,
);
