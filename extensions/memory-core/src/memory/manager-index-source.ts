import fs from "node:fs/promises";
import {
  isFileMissingError,
  retryTransientMemoryRead,
  type MemorySource,
  type MemoryWorkspaceFiles,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveMemoryPathClassification } from "./memory-path-provenance.js";

export async function readMemoryIndexSource({
  absolutePath,
  workspaceDir,
  source,
  suppliedContent,
  memoryFiles,
  artifactProvenance,
}: {
  absolutePath: string;
  workspaceDir: string;
  source: MemorySource;
  suppliedContent?: string;
  memoryFiles?: MemoryWorkspaceFiles;
  artifactProvenance?: Parameters<typeof resolveMemoryPathClassification>[0]["artifactProvenance"];
}) {
  const remoteRead =
    source === "memory" && memoryFiles
      ? await retryTransientMemoryRead(
          () => memoryFiles.readForIndexing(absolutePath),
          `read workspace memory for indexing ${absolutePath}`,
        ).catch((error: unknown) => {
          if (!isFileMissingError(error)) {
            throw error;
          }
          return null;
        })
      : undefined;
  if (remoteRead === null) {
    return null;
  }
  const pathClassification = await resolveMemoryPathClassification({
    absolutePath,
    source,
    workspaceDir,
    readSource: remoteRead,
    artifactProvenance,
  });
  const content =
    remoteRead?.content ??
    suppliedContent ??
    (await retryTransientMemoryRead(
      () => fs.readFile(absolutePath, "utf-8"),
      `read memory markdown for indexing ${absolutePath}`,
    ).catch((err: unknown) => {
      if (source !== "memory" || !isFileMissingError(err)) {
        throw err;
      }
      return null;
    }));
  if (content === null) {
    return null;
  }
  return { content, pathClassification };
}
