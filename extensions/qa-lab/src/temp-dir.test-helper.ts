import {
  createPrivateTempWorkspace,
  resolvePreferredOpenClawTmpDir,
  type PrivateTempWorkspace,
} from "openclaw/plugin-sdk/temp-path";

export function createTempDirHarness() {
  const tempDirs: PrivateTempWorkspace[] = [];

  return {
    async cleanup() {
      await Promise.all(tempDirs.splice(0).map((dir) => dir.cleanup()));
    },
    async makeTempDir(prefix: string) {
      const dir = await createPrivateTempWorkspace({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix,
      });
      tempDirs.push(dir);
      return dir.dir;
    },
  };
}
