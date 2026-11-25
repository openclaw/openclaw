import { spawn } from "node:child_process";

const [helperFlag, helper, rootFlag, root, ...args] = process.argv.slice(2);
if (helperFlag !== "--helper" || rootFlag !== "--root" || !helper || !root) {
  throw new Error("Invalid isolated candidate entrypoint.");
}
const config = process.env.OPENCLAW_CONFIG_PATH;
if (!config) {
  throw new Error("Isolated candidate runtime requires its synthetic configuration.");
}
const env = { PATH: process.env.PATH, LANG: "en_US.UTF-8" };
for (const key of [
  "VITEST",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_DEBUG_MODEL_TRANSPORT",
]) {
  if (process.env[key] !== undefined) {
    env[key] = process.env[key];
  }
}
// Native release fixtures use only this synthetic provider credential.
if (process.env.OPENAI_API_KEY) {
  if (!process.env.OPENAI_API_KEY.endsWith("synthetic-key")) {
    throw new Error("Native candidate qualification refuses a real provider credential.");
  }
  env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
}
const child = spawn("python3", [helper, "run", "--root", root, "--config", config, "--", ...args], {
  env,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.once("error", (error) => {
  console.error("Candidate isolation launcher failed: " + error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
