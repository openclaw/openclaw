import { spawnSync } from "node:child_process";
import path from "node:path";

const isLocalCheckEnabled = (env) => {
  const raw = env.OPENCLAW_LOCAL_CHECK?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
};

const args = process.argv.slice(2);
const env = { ...process.env };
const finalArgs = [...args];
const separatorIndex = finalArgs.indexOf("--");

const insertBeforeSeparator = (...items) => {
  const index = separatorIndex === -1 ? finalArgs.length : separatorIndex;
  finalArgs.splice(index, 0, ...items);
};

if (isLocalCheckEnabled(env) && !finalArgs.includes("--singleThreaded")) {
  insertBeforeSeparator("--singleThreaded");
  if (!env.GOGC) {
    env.GOGC = "30";
  }
}

const tsgoPath = path.resolve("node_modules", ".bin", "tsgo");
const result = spawnSync(tsgoPath, finalArgs, {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
