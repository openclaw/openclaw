import { documentExtractorWorkerEntrypoint } from "../../extensions/document-extract/document-extractor-worker-entrypoint.ts";
import { memoryCpuProcessEntrypoints } from "../../extensions/memory-core/src/memory/manager-cpu-entrypoints.ts";
import { vectorKnnProcessEntrypoint } from "../../extensions/memory-core/src/memory/manager-search-knn-entrypoint.ts";
import {
  createRuntimeProcessBuildEntries,
  runtimeProcessCoreEntrypoints,
} from "./runtime-process-core-build-entries.mts";

export const runtimeProcessBuildEntrypoints = [
  ...runtimeProcessCoreEntrypoints,
  vectorKnnProcessEntrypoint,
  documentExtractorWorkerEntrypoint,
  ...Object.values(memoryCpuProcessEntrypoints),
];
export const runtimeProcessBuildEntries = createRuntimeProcessBuildEntries(
  runtimeProcessBuildEntrypoints,
);
