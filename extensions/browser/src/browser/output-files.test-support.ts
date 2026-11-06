import { vi } from "vitest";
import type * as OutputFiles from "./output-files.js";

export function observeOutputWriteSettlement(outputFiles: typeof OutputFiles) {
  const writeSettled = Promise.withResolvers<void>();
  const writeOutput = outputFiles.writeExternalFileWithinOutputRoot;
  const write = vi
    .spyOn(outputFiles, "writeExternalFileWithinOutputRoot")
    .mockImplementation((params) => {
      const pending = writeOutput(params);
      void pending.then(
        () => writeSettled.resolve(),
        () => writeSettled.resolve(),
      );
      return pending;
    });
  return { write, writeSettled };
}
