import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const macIt = process.platform === "darwin" ? it : it.skip;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const verifier = resolve(import.meta.dirname, "../scripts/verify-native-helper.sh");

describe("FaceTime native helper verification", () => {
  macIt("rejects a valid signature from an unexpected signer", async () => {
    const fixture = tempDirs.make("openclaw-facetime-signature-");
    const source = join(fixture, "helper.c");
    const helper = join(fixture, "FaceTimeHelper.dylib");
    await writeFile(source, "int openclaw_facetime_helper_fixture(void) { return 1; }\n");
    await execFileAsync("/usr/bin/clang", ["-dynamiclib", source, "-o", helper]);
    await execFileAsync("/usr/bin/codesign", ["--force", "--sign", "-", helper]);
    await expect(
      execFileAsync("/usr/bin/codesign", ["--verify", "--strict", helper]),
    ).resolves.toBeDefined();

    await expect(execFileAsync("/bin/bash", [verifier, helper])).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "not signed by Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
      ),
    });
  });
});
