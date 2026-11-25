import { afterEach, expect, it } from "vitest";
import { runBunNativePolicyFixture } from "../../test/helpers/bun-native-policy.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const bunPosix = process.platform !== "win32" && process.env.OPENCLAW_TEST_BUN_LAUNCHER === "1";

it.runIf(bunPosix)(
  "preserves native filesystem policy across managed credential reads in a reused worker",
  () => {
    const home = temp.make("github-native-policy-");
    const result = runBunNativePolicyFixture(
      new URL("./github-tool-identity.bun.test-support.ts", import.meta.url),
      home,
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  },
);
