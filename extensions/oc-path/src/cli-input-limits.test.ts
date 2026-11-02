import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestRuntime,
  pathResolveCommand,
  stderrText,
  stdoutText,
} from "./cli.test-support.js";

const JSONC_INPUT_LIMIT_BYTES = 16 * 1024 * 1024;

describe("openclaw path CLI input limits", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("preserves the JSONC size refusal when read-only decoding expands invalid UTF-8", async () => {
    const workspaceDir = tempDirs.make("oc-path-cli-");
    const filePath = join(workspaceDir, "gateway.jsonc");
    const before = Buffer.alloc(Math.floor(JSONC_INPUT_LIMIT_BYTES / 3) + 1, 0xff);
    writeFileSync(filePath, before);
    expect(before.length).toBeLessThan(JSONC_INPUT_LIMIT_BYTES);
    const rt = createTestRuntime();
    await pathResolveCommand("oc://gateway.jsonc/value", { cwd: workspaceDir, json: true }, rt);

    expect(rt.exitCode).toBe(2);
    expect(stderrText(rt)).toBe("");
    expect(JSON.parse(stdoutText(rt))).toEqual({
      ok: false,
      error: {
        type: "cli_error",
        code: "OC_JSONC_INPUT_TOO_LARGE",
        message: `input exceeds MAX_JSONC_INPUT_BYTES (${JSONC_INPUT_LIMIT_BYTES} bytes; got ${before.length * 3})`,
      },
    });
    expect(readFileSync(filePath)).toEqual(before);
  });
});
