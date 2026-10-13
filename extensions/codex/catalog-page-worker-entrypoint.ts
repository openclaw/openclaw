export const codexCatalogPageWorkerEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "catalog-page.worker",
  distWorkerPath: "extensions/codex/catalog-page.worker.js",
  package: { name: "@openclaw/codex", distWorkerPath: "catalog-page.worker.js" },
} as const;
