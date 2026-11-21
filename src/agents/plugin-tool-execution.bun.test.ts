import { afterEach, expect, it } from "vitest";
import { runBunNativePolicyFixture } from "../../test/helpers/bun-native-policy.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
it.runIf(process.env.OPENCLAW_TEST_BUN_LAUNCHER === "1")(
  "preserves native canonicalization policy while reusing the sandbox projection worker",
  () => {
    const home = temp.make("sandbox-native-policy-");
    const result = runBunNativePolicyFixture(
      new URL("./plugin-tool-execution.bun.test-support.ts", import.meta.url),
      home,
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  },
);
