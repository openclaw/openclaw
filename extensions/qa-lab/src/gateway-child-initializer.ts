import path from "node:path";
import { pathToFileURL } from "node:url";
import { runQaGatewayCliCommand } from "./gateway-child-command.js";
import type { QaGatewayChildLifecycle } from "./gateway-child-lifecycle.js";
import { resolveQaNodeExecPath } from "./node-exec.js";

/** Load the built package's owners, not the test parent's source/runtime state. */
export async function initializeQaGatewayChildState(params: {
  repoRoot: string;
  tempRoot: string;
  env: NodeJS.ProcessEnv;
  lifetime: QaGatewayChildLifecycle;
}): Promise<void> {
  const runtimeUrl = pathToFileURL(path.join(params.repoRoot, "dist/plugin-sdk/qa-runtime.js"));
  await runQaGatewayCliCommand({
    lifetime: params.lifetime,
    executablePath: await resolveQaNodeExecPath(),
    argsPrefix: [],
    args: [
      "--input-type=module",
      "--eval",
      `const runtime = await import(${JSON.stringify(runtimeUrl.href)});\n` +
        `try { await runtime.initializeQaRuntimeState(); }\n` +
        `finally { await runtime.closeQaRuntimeStores(${JSON.stringify(params.tempRoot)}); }`,
    ],
    cwd: params.repoRoot,
    env: params.env,
  });
}
