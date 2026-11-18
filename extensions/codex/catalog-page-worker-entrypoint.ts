import { createPluginRuntimeProcessEntrypoint } from "openclaw/plugin-sdk/process-runtime";

export const codexCatalogPageWorkerEntrypoint = createPluginRuntimeProcessEntrypoint(
  "codexCatalogPage",
  import.meta.url,
);
