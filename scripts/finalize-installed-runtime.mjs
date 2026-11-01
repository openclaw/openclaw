#!/usr/bin/env node
// Build-time Linux admission only. Never invoked by a running Gateway or worker.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linkSourcePluginDependencies } from "./lib/bundled-plugin-dependency-links.mjs";

const app = fs.realpathSync(process.argv[2]);
if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("Installed runtime finalization requires Linux/x64");
}
// This probe never installs. Fail before postinstall can enter its missing-native repair.
let probe;
try {
  probe = JSON.parse(
    execFileSync(
      process.execPath,
      [path.join(app, "scripts/lib/fs-safe-prebuild.mjs"), "--probe", app],
      { encoding: "utf8" },
    ),
  );
} catch (cause) {
  throw new Error("Qualified fs-safe native prebuild is not loadable; no npm repair allowed", {
    cause,
  });
}
if (probe.status !== "ready") {
  throw new Error("Qualified fs-safe native prebuild is not loadable; no npm repair allowed");
}
execFileSync(process.execPath, [path.join(app, "scripts/postinstall-bundled-plugins.mjs")], {
  cwd: app,
  stdio: "inherit",
});
const plugins = path.join(app, "extensions");
for (const id of fs.readdirSync(plugins)) {
  const packaged = path.join(app, "dist/extensions", id);
  if (fs.existsSync(packaged)) {
    linkSourcePluginDependencies(path.join(plugins, id), path.join(packaged, "node_modules"));
  }
}
const scripts = path.dirname(fileURLToPath(import.meta.url));
execFileSync(process.execPath, [path.join(scripts, "prune-docker-plugin-dist.mjs")], {
  cwd: app,
  stdio: "inherit",
});
execFileSync(process.execPath, [path.join(scripts, "check-package-dist-imports.mjs"), app], {
  cwd: app,
  stdio: "inherit",
});
if (fs.existsSync(path.join(app, ".openclaw-lifecycle-pending"))) {
  throw new Error("Package lifecycle did not complete");
}
