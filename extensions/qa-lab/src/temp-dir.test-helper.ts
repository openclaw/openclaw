// Qa Lab plugin module implements temp dir helper behavior.
import { realpath } from "node:fs/promises";
import {
  tempWorkspace,
  resolvePreferredOpenClawTmpDir,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";

export function createTempDirHarness(
  options: { beforeCleanup?: (canonicalRoot: string) => Promise<void> } = {},
) {
  const tempDirs: TempWorkspace[] = [];

  return {
    cleanup: async () => {
      await Promise.all(
        tempDirs.splice(0).map(async (dir) => {
          if (options.beforeCleanup) {
            await options.beforeCleanup(await realpath(dir.dir));
          }
          await dir.cleanup();
        }),
      );
    },
    makeTempDir: async (prefix: string) => {
      const dir = await tempWorkspace({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix,
      });
      tempDirs.push(dir);
      return dir.dir;
    },
  };
}
