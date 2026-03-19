import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const STRIP_ONLY_TARGETS = [
  "extensions/discord/src/monitor/listeners.ts",
  "extensions/discord/src/voice/manager.ts",
];

describe("Discord strip-only compatibility", () => {
  it.each(STRIP_ONLY_TARGETS)("parses %s under Node strip-only mode", (relativePath) => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--check", path.resolve(process.cwd(), relativePath)],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
  });
});
