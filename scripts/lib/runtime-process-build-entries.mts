import { documentExtractorWorkerEntrypoint } from "../../extensions/document-extract/document-extractor-worker-entrypoint.ts";
import { memoryCpuProcessEntrypoints } from "../../extensions/memory-core/src/memory/manager-cpu-entrypoints.ts";
import {
  createRuntimeProcessBuildEntries,
  runtimeProcessCoreEntrypoints,
} from "./runtime-process-core-build-entries.mts";

export const runtimeProcessBuildEntrypoints = [
  ...runtimeProcessCoreEntrypoints,
  documentExtractorWorkerEntrypoint,
  ...Object.values(memoryCpuProcessEntrypoints),
];
export const runtimeProcessBuildEntries = createRuntimeProcessBuildEntries(
  runtimeProcessBuildEntrypoints,
);
