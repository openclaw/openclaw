import { spawnSync } from "node:child_process";

const testFiles = [
  "src/auto-reply/commands-registry.test.ts",
  "src/auto-reply/status.tools.test.ts",
  "src/auto-reply/reply/commands-info.commands.test.ts",
  "src/auto-reply/reply/commands-tasks.test.ts",
  "src/auto-reply/reply/commands-status.thinking-default.test.ts",
  "src/auto-reply/reply/commands-status.test.ts",
  "src/auto-reply/reply/commands-subagents/action-agents.test.ts",
  "src/auto-reply/reply/commands-subagents-focus.test.ts",
  "src/auto-reply/reply/commands-subagents/action-list.test.ts",
  "src/auto-reply/reply/commands-subagents/action-help.test.ts",
  "src/auto-reply/reply/commands-subagents/action-info.test.ts",
  "src/auto-reply/reply/commands-subagents/action-log.test.ts",
  "src/auto-reply/reply/commands-subagents/action-send.test.ts",
  "src/auto-reply/reply/commands-subagents/action-kill.test.ts",
  "src/auto-reply/reply/commands-subagents/action-spawn.test.ts",
  "src/auto-reply/reply/commands-acp/targets.test.ts",
];

const forwardedArgs = process.argv.slice(2).filter((arg) => arg !== "--");

if (forwardedArgs.includes("--list")) {
  for (const testFile of testFiles) {
    console.log(testFile);
  }
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [
    "scripts/run-vitest.mjs",
    "run",
    "--config",
    "vitest.config.ts",
    "--maxWorkers=1",
    ...forwardedArgs,
    ...testFiles,
  ],
  {
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
