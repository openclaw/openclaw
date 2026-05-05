import "../../../../src/infra/fs-safe-defaults.js";
export { isPathInside } from "@openclaw/fs-safe/path";
export {
  readRegularFile,
  statRegularFile,
  type RegularFileStatResult,
} from "@openclaw/fs-safe/advanced";
export { walkDirectory, type WalkDirectoryEntry } from "@openclaw/fs-safe/walk";

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
