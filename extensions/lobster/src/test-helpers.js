const PATH_ENV_KEYS = ["PATH", "Path", "PATHEXT", "Pathext"];
function setProcessPlatform(platform) {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true
  });
}
function snapshotPlatformPathEnv() {
  return {
    platformDescriptor: Object.getOwnPropertyDescriptor(process, "platform"),
    env: {
      PATH: process.env.PATH,
      Path: process.env.Path,
      PATHEXT: process.env.PATHEXT,
      Pathext: process.env.Pathext
    }
  };
}
function restorePlatformPathEnv(snapshot) {
  if (snapshot.platformDescriptor) {
    Object.defineProperty(process, "platform", snapshot.platformDescriptor);
  }
  for (const key of PATH_ENV_KEYS) {
    const value = snapshot.env[key];
    if (value === void 0) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}
import { createWindowsCmdShimFixture } from "../../shared/windows-cmd-shim-test-fixtures.js";
export {
  createWindowsCmdShimFixture,
  restorePlatformPathEnv,
  setProcessPlatform,
  snapshotPlatformPathEnv
};
