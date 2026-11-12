import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readActualWorkspaceManifestImpl } from "../../gateway/worker-environments/workspace-actual-manifest.js";
import {
  parseChangedWorkspaceResult,
  workspaceSizeRecoveryPaths,
} from "../../gateway/worker-environments/workspace-manifest-comparison.js";
import { MAX_RECONCILIATION_FILE_BYTES } from "../../gateway/worker-environments/workspace-manifest.js";
import { buildSandboxEnv } from "../bash-tools.shared.js";
import { resolveSandboxDependencyStore } from "./config-contract.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { buildSandboxCreateArgs } from "./container-allocation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Opt in with a local Node image; no downloads or registry access are needed.
it.runIf(process.env.OPENCLAW_TEST_TOOL_CACHE_IMAGE)(
  "captures npm task results without temporary or pre-upgrade caches and still rejects user files",
  async () => {
    const workspace = tempDirs.make("sandbox-tool-cache-");
    const docker = resolveSandboxDependencyStore(resolveSandboxConfigForAgent().docker);
    const { argv, env } = buildSandboxCreateArgs({
      name: `openclaw-tool-cache-${process.pid}`,
      cfg: docker,
      scopeKey: "tool-cache-proof",
    });
    const run = (args: string[]) => {
      const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const id = run([
      ...argv,
      ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      "--mount",
      `type=bind,source=${workspace},target=/workspace`,
      "--workdir",
      "/workspace",
      process.env.OPENCLAW_TEST_TOOL_CACHE_IMAGE!,
      "sleep",
      "infinity",
    ]);
    try {
      run(["start", id]);
      const taskEnv = buildSandboxEnv({
        defaultPath: "/usr/local/bin:/usr/bin:/bin",
        containerWorkdir: "/workspace",
        sandboxEnv: env,
      });
      run([
        "exec",
        ...Object.entries(taskEnv).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        id,
        "sh",
        "-c",
        `printf '%s' '{"name":"cache-proof","version":"1.0.0"}' > package.json && npm install --offline --ignore-scripts --no-audit --no-fund && node -e 'const fs=require("fs"); for(const root of [process.env.npm_config_cache || process.env.HOME+"/.npm","/workspace/.npm"]) { fs.mkdirSync(root+"/_cacache",{recursive:true});fs.writeFileSync(root+"/_cacache/blob","");fs.truncateSync(root+"/_cacache/blob",${MAX_RECONCILIATION_FILE_BYTES + 1}); } fs.writeFileSync("answer.txt","done");'`,
      ]);
      const base = { version: 1 as const, baseCommit: null, entries: [] };
      const capture = async () =>
        (await readActualWorkspaceManifestImpl({ root: workspace, baseCommit: null })).manifest;
      const result = parseChangedWorkspaceResult(base, await capture());
      expect(result.entries.map((entry) => entry.path).toSorted()).toEqual([
        "answer.txt",
        "package-lock.json",
        "package.json",
      ]);
      expect(run(["exec", id, "npm", "config", "get", "cache"])).toBe(
        "/tmp/openclaw-deps/cache/npm",
      );
      expect(run(["exec", id, "df", "-k", "/tmp/openclaw-deps"])).toMatch(/4194304/);
      await fs.writeFile(path.join(workspace, "user.bin"), "");
      await fs.truncate(path.join(workspace, "user.bin"), MAX_RECONCILIATION_FILE_BYTES + 1);
      const oversized = await capture();
      expect(() => parseChangedWorkspaceResult(base, oversized)).toThrow(
        "Cloud workspace result is too large: user.bin",
      );
      oversized.entries = oversized.entries.map((entry) =>
        entry.path === "user.bin" ? { ...entry, path: "project/.npm/_cacache/blob" } : entry,
      );
      expect(() => parseChangedWorkspaceResult(base, oversized)).toThrow(
        "Directory class: npm cache. Set npm_config_cache",
      );
      try {
        parseChangedWorkspaceResult(base, oversized);
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        expect(workspaceSizeRecoveryPaths(error)).toEqual(["project/.npm/_cacache/blob"]);
      }
    } finally {
      run(["rm", "-f", id]);
    }
  },
);
