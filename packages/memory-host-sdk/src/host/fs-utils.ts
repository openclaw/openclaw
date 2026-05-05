export { readRegularFile, statRegularFile, type RegularFileStatResult } from "@openclaw/fs-safe";

export function isFileMissingError(
  err: unknown,
): err is NodeJS.ErrnoException & { code: "ENOENT" } {
  return Boolean(
    err &&
    typeof err === "object" &&
    "code" in err &&
    (err as Partial<NodeJS.ErrnoException>).code === "ENOENT",
  );
}
