import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspaceDotEnvFile } from "../infra/dotenv.js";
import { captureEnv } from "../test-utils/env.js";
import { installSkill } from "./skills-install.js";

describe("workspace .env UV_PYTHON handling for uv skill installs", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;

  afterEach(async () => {
    envSnapshot?.restore();
    envSnapshot = undefined;
  });

  it.runIf(process.platform !== "win32")(
    "does not propagate UV_PYTHON from workspace dotenv into uv tool install execution",
    async () => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-poc-uv-python-"));
      const cwdDir = path.join(base, "cwd");
      const binDir = path.join(base, "bin");
      const markerPath = path.join(base, "uv-python-marker.txt");
      const fakeUvPath = path.join(binDir, "uv");
      try {
        await fs.mkdir(cwdDir, { recursive: true });
        await fs.mkdir(binDir, { recursive: true });
        await fs.mkdir(path.join(cwdDir, "skills", "uv-skill"), { recursive: true });

        await fs.writeFile(
          path.join(cwdDir, "skills", "uv-skill", "SKILL.md"),
          [
            "---",
            "name: uv-skill",
            "description: uv install PoC",
            'metadata: {"openclaw":{"install":[{"id":"deps","kind":"uv","package":"httpie==3.2.2"}]}}',
            "---",
            "",
            "# uv-skill",
            "",
          ].join("\n"),
          "utf8",
        );

        await fs.writeFile(
          fakeUvPath,
          [
            "#!/bin/sh",
            'printf "%s\\n" "$UV_PYTHON" > "$OPENCLAW_POC_MARKER_PATH"',
            "exit 0",
            "",
          ].join("\n"),
          "utf8",
        );
        await fs.chmod(fakeUvPath, 0o755);

        const attackerPython = path.join(base, "attacker-python");
        await fs.writeFile(path.join(cwdDir, ".env"), `UV_PYTHON=${attackerPython}\n`, "utf8");

        envSnapshot = captureEnv(["PATH", "UV_PYTHON", "OPENCLAW_POC_MARKER_PATH"]);
        delete process.env.UV_PYTHON;
        process.env.OPENCLAW_POC_MARKER_PATH = markerPath;
        process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });
        expect(process.env.UV_PYTHON).toBeUndefined();

        const result = await installSkill({
          workspaceDir: cwdDir,
          skillName: "uv-skill",
          installId: "deps",
          timeoutMs: 10_000,
        });

        expect(result.ok).toBe(true);
        await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("\n");
      } finally {
        await fs.rm(base, { recursive: true, force: true });
      }
    },
  );
});
