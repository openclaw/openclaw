import { DEFAULT_SECRET_FILE_MAX_BYTES, readSecretFileSync } from "../infra/secret-file.js";

/** Reads an ACP secret file with the shared secret-file size and symlink policy. */
export function readSecretFromFile(filePath: string, label: string): string {
  return readSecretFileSync(filePath, label, {
    maxBytes: DEFAULT_SECRET_FILE_MAX_BYTES,
    rejectSymlink: true,
  });
}
