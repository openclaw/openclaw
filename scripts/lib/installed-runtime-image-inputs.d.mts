export function verifyInstalledRuntimeImageInputs(options: {
  appRoot: string;
  nativeToolRoot: string;
  runtimeCommit: string;
  sourceLockSha256: string;
  availableFiles: string[];
}): Promise<Array<{ path: string; sha256: string }>>;
