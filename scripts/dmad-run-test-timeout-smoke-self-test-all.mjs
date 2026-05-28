import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export const timeoutSmokeSelfTestScriptPaths = [
  path.join(scriptDir, "dmad-run-test-timeout-smoke-self-test.mjs"),
  path.join(scriptDir, "dmad-run-test-timeout-smoke-override-self-test.mjs"),
  path.join(scriptDir, "dmad-run-test-timeout-smoke-override-quick-check-self-test.mjs"),
  path.join(scriptDir, "dmad-run-test-live-smoke-self-test.mjs"),
];

function runSingleSelfTest(scriptPath, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env,
      stdio: "inherit",
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`self-test terminated by signal: ${signal}`));
        return;
      }
      if ((code ?? 1) !== 0) {
        reject(new Error(`self-test failed (${path.basename(scriptPath)}) with exit code ${code}`));
        return;
      }
      resolve();
    });
  });
}

export async function runTimeoutSmokeSelfTestAll() {
  for (const scriptPath of timeoutSmokeSelfTestScriptPaths) {
    console.log(
      `[dmad-run-test-timeout-smoke-self-test-all] running: ${path.basename(scriptPath)}`,
    );
    await runSingleSelfTest(scriptPath);
  }
  console.log("[dmad-run-test-timeout-smoke-self-test-all] PASS");
}

const isDirectRun = Boolean(
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url,
);

if (isDirectRun) {
  runTimeoutSmokeSelfTestAll().catch((error) => {
    console.error("[dmad-run-test-timeout-smoke-self-test-all] failed:", error);
    process.exit(1);
  });
}
