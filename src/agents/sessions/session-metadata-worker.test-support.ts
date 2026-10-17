import { vi } from "vitest";
import * as runtime from "./session-manager-metadata-runtime.js";

type Worker = Parameters<Parameters<typeof runtime.withSessionMetadataWorker>[3]>[0];

export function interceptSessionMetadataWorker(wrap: (worker: Worker) => Worker) {
  const original = runtime.withSessionMetadataWorker;
  return vi
    .spyOn(runtime, "withSessionMetadataWorker")
    .mockImplementation((options, database, assertCurrent, operation, controls) =>
      original(options, database, assertCurrent, (worker) => operation(wrap(worker)), controls),
    );
}
