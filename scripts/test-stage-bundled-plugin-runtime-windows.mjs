import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageBundledPluginRuntime } from "./stage-bundled-plugin-runtime.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-overlay-win-"));

function cleanup() {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

const pluginId = "runtime-win-fallback-plugin";
const sourcePluginDir = path.join(tempRoot, "dist", "extensions", pluginId);
const sourceSkillDir = path.join(sourcePluginDir, "skills", "acp-router");
fs.mkdirSync(sourceSkillDir, { recursive: true });
fs.writeFileSync(
  path.join(sourcePluginDir, "package.json"),
  JSON.stringify({ name: "@openclaw/runtime-win-fallback-plugin", type: "module" }, null, 2),
  "utf8",
);
fs.writeFileSync(
  path.join(sourcePluginDir, "openclaw.plugin.json"),
  JSON.stringify({ id: pluginId }, null, 2),
  "utf8",
);
fs.writeFileSync(path.join(sourcePluginDir, "index.js"), "export const ok = true;\n", "utf8");
fs.writeFileSync(path.join(sourceSkillDir, "SKILL.md"), "# Runtime fallback skill\n", "utf8");

const fsImpl = {
  ...fs,
  symlinkSync(targetValue, targetPath, type) {
    if (type === "junction") {
      return fs.symlinkSync(targetValue, targetPath, type);
    }
    const error = new Error("operation not permitted");
    error.code = "EPERM";
    throw error;
  },
};

stageBundledPluginRuntime({ repoRoot: tempRoot, fsImpl, platform: "win32" });

const runtimeSkillPath = path.join(
  tempRoot,
  "dist-runtime",
  "extensions",
  pluginId,
  "skills",
  "acp-router",
  "SKILL.md",
);
assert.ok(fs.existsSync(runtimeSkillPath), "runtime skill file missing after Windows fallback staging");
assert.equal(fs.readFileSync(runtimeSkillPath, "utf8"), "# Runtime fallback skill\n");
assert.equal(fs.lstatSync(runtimeSkillPath).isSymbolicLink(), false);

process.stdout.write("[runtime-overlay] windows symlink fallback smoke passed\n");
