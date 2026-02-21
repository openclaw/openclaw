import { describe, expect, it } from "vitest";
import { runExecProcess } from "./bash-tools.exec-runtime.js";

describe("exec runtime onUpdate guard (issue #22206)", () => {
  it("should not crash when onUpdate is truthy but not a function", async () => {
    // Reproduces issue #22206: onUpdate can be set to `true` or an object during
    // teardown/race, causing TypeError when the falsy check passes but the call fails.
    // Before fix: TypeError: opts.onUpdate is not a function at line 340
    // After fix: typeof check prevents the call

    await expect(
      runExecProcess({
        command: "echo hello",
        // @ts-expect-error - Testing invalid type to reproduce crash
        onUpdate: true, // Truthy but not callable
        workdir: process.cwd(),
        allowElevated: false,
        env: {},
        warnings: [],
      }),
    ).resolves.toBeDefined();
  });

  it("should not crash when onUpdate is an object", async () => {
    await expect(
      runExecProcess({
        command: "echo test",
        // @ts-expect-error - Testing invalid type
        onUpdate: {}, // Another truthy non-function value
        workdir: process.cwd(),
        allowElevated: false,
        env: {},
        warnings: [],
      }),
    ).resolves.toBeDefined();
  });
});
