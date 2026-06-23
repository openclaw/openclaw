// Qa E2E script supports OpenClaw repository automation.
import { pathToFileURL } from "node:url";

type QaE2eRuntime = Pick<
  typeof import("../extensions/qa-lab/api.js"),
  "isQaSelfCheckSuccessful" | "runQaE2eSelfCheck"
>;

type QaE2eDeps = {
  env?: NodeJS.ProcessEnv;
  loadRuntime?: () => Promise<QaE2eRuntime>;
  writeStdout?: (text: string) => void;
};

async function loadQaE2eRuntime(): Promise<QaE2eRuntime> {
  return await import("../extensions/qa-lab/api.js");
}

export function enablePrivateQaScriptEnv(env: NodeJS.ProcessEnv = process.env) {
  env.OPENCLAW_BUILD_PRIVATE_QA = "1";
  env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = "1";
  env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "0";
}

export function resolveQaE2eOutputPath(argv: readonly string[] = process.argv.slice(2)) {
  return argv[0]?.trim() || ".artifacts/qa-e2e/self-check.md";
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: QaE2eDeps = {},
): Promise<number> {
  enablePrivateQaScriptEnv(deps.env ?? process.env);
  const { isQaSelfCheckSuccessful, runQaE2eSelfCheck } = await (
    deps.loadRuntime ?? loadQaE2eRuntime
  )();
  const result = await runQaE2eSelfCheck({ outputPath: resolveQaE2eOutputPath(argv) });
  (deps.writeStdout ?? ((text: string) => process.stdout.write(text)))(
    `QA self-check report: ${result.outputPath}\n`,
  );
  return isQaSelfCheckSuccessful(result) ? 0 : 1;
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  process.exitCode = await main();
}
