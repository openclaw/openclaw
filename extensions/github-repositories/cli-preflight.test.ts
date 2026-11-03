import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { assertGitHubCliAvailable } from "./cli-preflight-api.js";

describe("GitHub CLI preflight", () => {
  it("recognizes an installation immediately after a missing-CLI retry", async () => {
    await withTempDir("openclaw-github-cli-", async (binDir) => {
      const executableName = process.platform === "win32" ? "gh.cmd" : "gh";
      const executablePath = path.join(binDir, executableName);
      const env = {
        PATH: binDir,
        ...(process.platform === "win32" ? { PATHEXT: ".CMD" } : {}),
      };

      expect(() => assertGitHubCliAvailable(env)).toThrow("GitHub CLI (`gh`) is required");
      await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

      expect(() => assertGitHubCliAvailable(env)).not.toThrow();
      await fs.rm(executablePath);
      expect(() => assertGitHubCliAvailable(env)).toThrow("GitHub CLI (`gh`) is required");
    });
  });
});
