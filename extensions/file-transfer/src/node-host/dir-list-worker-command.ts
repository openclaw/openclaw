import {
  createPluginRuntimeProcessEntrypoint,
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";

const workerEntry = createPluginRuntimeProcessEntrypoint("fileTransferDirList", import.meta.url);

export function createCanonicalDirListCommand(input: {
  directoryPath: string;
  expectedCanonicalPath: string;
  expectedDevice: string;
  expectedInode: string;
  maxEntries: number;
  offset: number;
}): string[] {
  return [
    process.execPath,
    ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(workerEntry)),
    input.directoryPath,
    input.expectedCanonicalPath,
    input.expectedDevice,
    input.expectedInode,
    String(input.offset),
    String(input.maxEntries),
  ];
}
