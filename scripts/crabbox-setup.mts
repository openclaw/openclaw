import { appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureManagedCrabboxBinary,
  resolveCrabboxBinary,
} from "../extensions/crabbox/cli-runtime-api.js";
import { resolvePathEnvKey } from "./windows-cmd-helpers.mjs";

const cli = await ensureManagedCrabboxBinary({
  binary: resolveCrabboxBinary({
    openclawRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    pathEnv: process.env[resolvePathEnvKey(process.env)],
  }),
});
if (process.env.GITHUB_PATH) {
  await appendFile(process.env.GITHUB_PATH, `${dirname(cli.binary)}\n`);
}
console.log(JSON.stringify(cli));
