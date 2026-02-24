#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cfgPath =
  process.env.OPENCLAW_CONFIG || path.join(os.homedir(), ".openclaw", "openclaw.json");
const raw = fs.readFileSync(cfgPath, "utf8");
const cfg = JSON.parse(raw);
const violations = [];

for (const [channel, channelCfg] of Object.entries(cfg.channels ?? {})) {
  if (channelCfg && channelCfg.requiresRuntime === false) {
    violations.push({ channel, scope: "channel" });
  }
  for (const [accountId, accountCfg] of Object.entries(channelCfg?.accounts ?? {})) {
    if (accountCfg && accountCfg.requiresRuntime === false) {
      violations.push({ channel, scope: "account", accountId });
    }
  }
}

if (violations.length > 0) {
  console.error("CONFIG_LINT_FAIL requiresRuntime=false detected");
  console.error(JSON.stringify({ cfgPath, violations }, null, 2));
  process.exit(2);
}

console.log("CONFIG_LINT_PASS requiresRuntime policy satisfied");
console.log(
  JSON.stringify({ cfgPath, checkedChannels: Object.keys(cfg.channels ?? {}).length }, null, 2),
);
