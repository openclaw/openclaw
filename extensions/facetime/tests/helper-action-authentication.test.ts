import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("FaceTime helper action authentication", () => {
  it(
    "rejects same-session replay and envelopes captured before reconnect",
    { timeout: 20_000 },
    () => {
      const outputDir = mkdtempSync(path.join(tmpdir(), "facetime-helper-auth."));
      const binary = path.join(outputDir, "action-auth-tests");
      try {
        // Cold macOS CI compiles this native harness inside the test, so allow
        // toolchain startup without weakening any authentication assertion.
        execFileSync("/usr/bin/clang", [
          "-fobjc-arc",
          "-framework",
          "Foundation",
          path.join(packageRoot, "helper/FaceTimeHelper/ActionAuthentication.m"),
          path.join(packageRoot, "helper/tests/ActionAuthenticationTests.m"),
          "-o",
          binary,
        ]);
        expect(() => execFileSync(binary)).not.toThrow();
      } finally {
        if (existsSync("/usr/bin/trash")) {
          execFileSync("/usr/bin/trash", [outputDir]);
        } else {
          execFileSync("/usr/bin/python3", [
            "-c",
            "import shutil, sys; shutil.rmtree(sys.argv[1])",
            outputDir,
          ]);
        }
      }
    },
  );
});
