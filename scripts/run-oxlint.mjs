import { spawnSync } from "node:child_process";
import path from "node:path";

const isLocalCheckEnabled = (env) => {
  const raw = env.OPENCLAW_LOCAL_CHECK?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
};

const hasFlag = (args, name) => args.some((arg) => arg === name || arg.startsWith(`${name}=`));

const args = process.argv.slice(2);
const env = { ...process.env };
const finalArgs = [...args];
const separatorIndex = finalArgs.indexOf("--");

const insertBeforeSeparator = (...items) => {
  const index = separatorIndex === -1 ? finalArgs.length : separatorIndex;
  finalArgs.splice(index, 0, ...items);
};

if (!hasFlag(finalArgs, "--type-aware")) {
  insertBeforeSeparator("--type-aware");
}
if (!hasFlag(finalArgs, "--tsconfig")) {
  insertBeforeSeparator("--tsconfig", "tsconfig.oxlint.json");
}
if (isLocalCheckEnabled(env) && !hasFlag(finalArgs, "--threads")) {
  insertBeforeSeparator("--threads=1");
}

const oxlintPath = path.resolve("node_modules", ".bin", "oxlint");
const result = spawnSync(oxlintPath, finalArgs, {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
