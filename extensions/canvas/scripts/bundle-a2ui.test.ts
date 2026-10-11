// Canvas tests cover bundle a2ui plugin behavior.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, it, vi } from "vitest";
import { compareNormalizedPaths, listTrackedInputFiles } from "./bundle-a2ui.mjs";

describe("scripts/bundle-a2ui.mjs", () => {
  it("requires both prebuilt dialects when the A2UI build dependencies are absent", async () => {
    await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-a2ui-prebuilt-" },
      async ({ dir }) => {
        const scriptsDir = path.join(dir, "extensions", "canvas", "scripts");
        await fs.mkdir(scriptsDir, { recursive: true });
        for (const name of ["bundle-a2ui.mjs", "pnpm-runner.mjs"]) {
          await fs.copyFile(new URL(`./${name}`, import.meta.url), path.join(scriptsDir, name));
        }
        const outputFile = path.join(dir, "a2ui.bundle.js");
        await fs.writeFile(outputFile, "// v0.8 prebuilt renderer\n");
        const run = () =>
          spawnSync(process.execPath, [path.join(scriptsDir, "bundle-a2ui.mjs")], {
            cwd: dir,
            encoding: "utf8",
            env: {
              ...process.env,
              OPENCLAW_A2UI_BUNDLE_OUT: outputFile,
              OPENCLAW_SPARSE_PROFILE: "",
              OPENCLAW_A2UI_SKIP_MISSING: "0",
            },
          });

        const incomplete = run();
        expect(incomplete.status).toBe(1);
        expect(incomplete.stderr).toContain("no complete prebuilt bundle");
        expect(incomplete.stderr).toContain(`${outputFile}.v0.9.js`);

        await fs.writeFile(`${outputFile}.v0.9.js`, "// v0.9 prebuilt renderer\n");
        const complete = run();
        expect(complete.status).toBe(0);
        expect(complete.stdout).toContain("keeping prebuilt bundle");
      },
    );
  });

  it("sorts hash inputs without locale-dependent collation", () => {
    const paths = ["repo/Z.ts", "repo/a.ts", "repo/ä.ts", "repo/A.ts"];

    expect([...paths].toSorted(compareNormalizedPaths)).toEqual([
      "repo/A.ts",
      "repo/Z.ts",
      "repo/a.ts",
      "repo/ä.ts",
    ]);
  });

  it("bounds tracked-input discovery and treats a timeout as a fallback", () => {
    const repoRoot = path.resolve("repo-root");
    const runGit = vi.fn(() => ({ status: null, stdout: "" }));

    expect(listTrackedInputFiles(runGit, repoRoot)).toBeNull();
    expect(runGit).toHaveBeenCalledWith(
      "git",
      [
        "ls-files",
        "--",
        "package.json",
        "pnpm-lock.yaml",
        "extensions/canvas/package.json",
        "extensions/canvas/scripts/bundle-a2ui.mjs",
        "extensions/canvas/src/host/a2ui-app",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      },
    );
  });

  it.skipIf(process.platform === "win32")(
    "matches the tracked-input hash when Git discovery fails",
    async () => {
      await withTempWorkspace(
        { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-a2ui-git-fallback-" },
        async ({ dir }) => {
          const fakeBinDir = path.join(dir, "bin");
          const fakeGitPath = path.join(fakeBinDir, "git");
          const outputFile = path.join(dir, "a2ui.bundle.js");
          const hashFile = path.join(dir, "a2ui.bundle.hash");
          const scriptPath = path.resolve("extensions/canvas/scripts/bundle-a2ui.mjs");
          const baseEnv = {
            ...process.env,
            OPENCLAW_A2UI_BUNDLE_HASH_FILE: hashFile,
            OPENCLAW_A2UI_BUNDLE_OUT: outputFile,
          };
          await fs.mkdir(fakeBinDir, { recursive: true });
          await fs.writeFile(fakeGitPath, `#!${process.execPath}\nprocess.exit(1);\n`, "utf8");
          await fs.chmod(fakeGitPath, 0o755);

          execFileSync(process.execPath, [scriptPath], {
            cwd: process.cwd(),
            encoding: "utf8",
            env: baseEnv,
            killSignal: "SIGKILL",
            timeout: 12_000,
          });
          const trackedHash = await fs.readFile(hashFile, "utf8");

          execFileSync(process.execPath, [scriptPath], {
            cwd: process.cwd(),
            encoding: "utf8",
            env: {
              ...baseEnv,
              PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
            },
            killSignal: "SIGKILL",
            timeout: 12_000,
          });

          await expect(fs.readFile(hashFile, "utf8")).resolves.toBe(trackedHash);
          await expect(fs.stat(outputFile)).resolves.toBeDefined();
        },
      );
    },
  );
});
