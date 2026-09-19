import fs from "node:fs/promises";
import path from "node:path";
import { assertOwnedPath } from "./extension-install-layout.js";

export async function assertPrivateNativeHostFile(
  target: string,
  executable: boolean,
  platform: NodeJS.Platform,
): Promise<void> {
  await assertOwnedPath(target, "file");
  if (platform === "win32") {
    return;
  }
  const mode = (await fs.lstat(target)).mode & 0o777;
  if ((mode & 0o077) !== 0 || (executable && (mode & 0o100) === 0)) {
    throw new Error("native host file has unsafe mode");
  }
}

export async function assertNativeHostTarget(target: string, accessMode: number): Promise<void> {
  // Registered targets must not depend on Chrome's working directory.
  if (!path.isAbsolute(target)) {
    throw new Error("native host target must be an absolute path");
  }
  await assertOwnedPath(target, "file", { allowRootOwner: true });
  await fs.access(target, accessMode);
}
