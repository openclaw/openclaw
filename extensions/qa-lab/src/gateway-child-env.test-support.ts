/** Models packaged auth stdin before the subsequent Gateway environment capture. */
export function createQaPackagedCredentialCaptureScript(observedEnvPath: string): string {
  // The eval entry receives its command at argv[1]. Keep auth alive through EOF
  // so bootstrap cannot race the parent's credential write with child exit.
  return [
    'const fs = require("node:fs");',
    'if (process.argv[1] === "models") { process.stdin.resume(); } else {',
    "const env = {",
    "SAFE_VALUE: process.env.SAFE_VALUE,",
    "OPENCLAW_LIVE_SETUP_TOKEN_VALUE: process.env.OPENCLAW_LIVE_SETUP_TOKEN_VALUE,",
    "OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN: process.env.OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN,",
    "OPENCLAW_QA_CONVEX_SECRET_CI: process.env.OPENCLAW_QA_CONVEX_SECRET_CI,",
    "OPENCLAW_QA_SUT_FORBIDDEN_SENTINEL: process.env.OPENCLAW_QA_SUT_FORBIDDEN_SENTINEL,",
    "OPENCLAW_QA_TELEGRAM_GROUP_ID: process.env.OPENCLAW_QA_TELEGRAM_GROUP_ID,",
    "OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: process.env.OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN,",
    "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: process.env.OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN,",
    "OPENCLAW_DEV_SOURCE_ROOT: process.env.OPENCLAW_DEV_SOURCE_ROOT,",
    "};",
    `fs.writeFileSync(${JSON.stringify(observedEnvPath)}, JSON.stringify(env));`,
    "}",
  ].join("\n");
}

export function createQaPackagedSourceRootCaptureScript(observedEnvPath: string): string {
  // File entrypoints include the script path, so their command starts at argv[2].
  return [
    'import fs from "node:fs";',
    'if (process.argv[2] === "models") { process.stdin.resume(); } else {',
    `fs.writeFileSync(${JSON.stringify(observedEnvPath)}, process.env.OPENCLAW_DEV_SOURCE_ROOT ?? "");`,
    "}",
  ].join("\n");
}
