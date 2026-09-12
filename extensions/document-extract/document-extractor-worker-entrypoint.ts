export const documentExtractorWorkerEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "document-extractor.worker",
  distWorkerPath: "extensions/document-extract/document-extractor.worker.js",
} as const;
