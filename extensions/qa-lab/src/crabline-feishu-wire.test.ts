import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveTestNodeExecPath } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";

describe("Crabline Feishu wire codec", () => {
  it("preserves proto2 wire behavior without compiling code at runtime", () => {
    const result = spawnSync(
      resolveTestNodeExecPath(),
      [
        "--disallow-code-generation-from-strings",
        fileURLToPath(new URL("../test-fixtures/crabline-feishu-wire.mjs", import.meta.url)),
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("Feishu protobuf wire fixtures passed");
  });
});
