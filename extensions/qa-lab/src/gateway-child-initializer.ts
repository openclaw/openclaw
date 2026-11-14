import { runQaGatewayCliCommand } from "./gateway-child-command.js";
import type { QaGatewayChildLifecycle } from "./gateway-child-lifecycle.js";

/** Bootstrap through the same configured launcher and isolation as the Gateway. */
export async function initializeQaGatewayChildState(params: {
  executablePath: string;
  argsPrefix: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  lifetime: QaGatewayChildLifecycle;
}): Promise<void> {
  await runQaGatewayCliCommand({
    ...params,
    args: ["qa", "initialize"],
    env: { ...params.env, OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1" },
  });
}
