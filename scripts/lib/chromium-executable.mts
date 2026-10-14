import { spawnSync as spawnSyncImpl } from "node:child_process";
import { existsSync as existsSyncImpl } from "node:fs";

export type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: Record<string, unknown>,
) => { status: number | null };

export type ChromiumExecutableOptions = {
  existsSync?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  spawnSync?: SpawnSyncLike;
};

export function canRunChromiumExecutable(
  executablePath: string,
  options: ChromiumExecutableOptions = {},
): boolean {
  // Chrome's --version exit path is POSIX-only; on Windows it hangs discovery.
  // Playwright owns the actual launch validation on Windows.
  return (
    (options.existsSync ?? existsSyncImpl)(executablePath) &&
    ((options.platform ?? process.platform) === "win32" ||
      (options.spawnSync ?? spawnSyncImpl)(executablePath, ["--version"], { stdio: "ignore" })
        .status === 0)
  );
}
