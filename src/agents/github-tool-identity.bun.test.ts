import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const bunPosix = process.platform !== "win32" && process.env.OPENCLAW_TEST_BUN_LAUNCHER === "1";

it.runIf(bunPosix)(
  "preserves native filesystem policy across managed credential reads in a reused worker",
  () => {
    const home = temp.make("github-native-policy-");
    const result = spawnSync(
      process.env.BUN_BIN ?? "bun",
      [
        "--no-install",
        "--no-addons",
        "--conditions=openclaw-custom",
        fileURLToPath(new URL("./github-tool-identity.bun.test-support.ts", import.meta.url)),
        home,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 60_000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: home,
          USERPROFILE: home,
          TMPDIR: home,
          OPENCLAW_STATE_DIR: home,
          FS_SAFE_NATIVE_MODE: "auto",
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  },
);
