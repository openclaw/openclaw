import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixtures = ["realtime-numeric-codecs.mjs", "realtime-dtls-codecs.mjs"];

describe("realtime binary codecs without code generation", () => {
  it.each(fixtures)("preserves %s wire behavior with string compilation disabled", (fixture) => {
    const result = spawnSync(
      process.execPath,
      [
        "--disallow-code-generation-from-strings",
        fileURLToPath(new URL(`./test-support/${fixture}`, import.meta.url)),
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("passed");
  });
});
