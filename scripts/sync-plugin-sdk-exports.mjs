#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { buildPluginSdkPackageExports } from "./lib/plugin-sdk-entries.mjs";

const packageJsonPath = path.join(process.cwd(), "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const currentExports = packageJson.exports ?? {};
const syncedPluginSdkExports = buildPluginSdkPackageExports();

const nextExports = {};
let insertedPluginSdkExports = false;
for (const [key, value] of Object.entries(currentExports)) {
  if (key.startsWith("./plugin-sdk")) {
    if (!insertedPluginSdkExports) {
      Object.assign(nextExports, syncedPluginSdkExports);
      insertedPluginSdkExports = true;
    }
    continue;
  }
  nextExports[key] = value;
  if (key === "." && !insertedPluginSdkExports) {
    Object.assign(nextExports, syncedPluginSdkExports);
    insertedPluginSdkExports = true;
  }
}

if (!insertedPluginSdkExports) {
  Object.assign(nextExports, syncedPluginSdkExports);
}

packageJson.exports = nextExports;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
