import {
  createPluginRuntimeProcessEntrypoint,
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
  runCommandBuffered,
} from "openclaw/plugin-sdk/process-runtime";

const CANONICAL_PATH_CHANGED_EXIT_CODE = 78;
const workerEntry = createPluginRuntimeProcessEntrypoint("fileTransferDirFetch", import.meta.url);

type TarArchiveResult = Buffer | "TOO_LARGE" | "TIMEOUT" | "CANONICAL_PATH_CHANGED" | "ERROR";

export async function createTarArchive(
  directoryPath: string,
  expectedCanonicalPath: string,
  expectedDevice: string,
  expectedInode: string,
  maxBytes: number,
): Promise<TarArchiveResult> {
  const tarBin = process.platform !== "win32" ? "/usr/bin/tar" : "tar";
  const timeoutMs = 60_000;

  // chdir binds the worker to one directory object. Verifying that bound cwd
  // before spawning tar prevents a later path replacement from changing input.
  const result = await runCommandBuffered(
    [
      process.execPath,
      ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(workerEntry)),
      directoryPath,
      expectedCanonicalPath,
      expectedDevice,
      expectedInode,
      tarBin,
    ],
    {
      discardOutput: { stderr: true },
      maxOutputBytes: { stdout: maxBytes, stderr: 64 * 1024 },
      timeoutMs,
    },
  ).catch(() => null);
  if (!result) {
    return "ERROR";
  }
  if (result.termination === "timeout") {
    return "TIMEOUT";
  }
  if (result.termination === "output-limit" && result.outputLimitStream === "stdout") {
    return "TOO_LARGE";
  }
  if (result.termination === "exit" && result.code === CANONICAL_PATH_CHANGED_EXIT_CODE) {
    return "CANONICAL_PATH_CHANGED";
  }
  return result.termination === "exit" && result.code === 0 ? result.stdout : "ERROR";
}
