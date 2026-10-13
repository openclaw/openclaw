import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  assertMatrixQaPrivatePathMode,
  createMatrixQaOpenClawCliRuntime,
  runMatrixQaOpenClawCli,
} from "./scenario-runtime-cli.js";
import { buildMatrixQaCliE2eeAccountConfig } from "./scenario-runtime-e2ee-cli-config.js";
import { buildMatrixQaEmptyMatrixCliConfig } from "./scenario-runtime-e2ee-cli-shared.js";
import {
  requireMatrixQaCliRuntimeEnv,
  requireMatrixQaE2eeOutputDir,
} from "./scenario-runtime-e2ee-shared.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

export async function createMatrixQaCliSelfVerificationRuntime(params: {
  accountId: string;
  accessToken: string;
  context: MatrixQaScenarioContext;
  deviceId: string;
  userId: string;
}) {
  return await createMatrixQaCliE2eeSetupRuntime({
    artifactLabel: "cli-self-verification",
    context: params.context,
    initialConfig: buildMatrixQaCliE2eeAccountConfig({
      accountId: params.accountId,
      accessToken: params.accessToken,
      baseUrl: params.context.baseUrl,
      deviceId: params.deviceId,
      encryption: true,
      initialSyncLimit: 0,
      name: "Matrix QA CLI self-verification",
      userId: params.userId,
    }),
  });
}

export async function createMatrixQaCliE2eeSetupRuntime(params: {
  artifactLabel: string;
  context: MatrixQaScenarioContext;
  initialConfig?: Record<string, unknown>;
}) {
  const runtime = await createMatrixQaOpenClawCliRuntime({
    artifactLabel: params.artifactLabel,
    initialConfig: params.initialConfig ?? buildMatrixQaEmptyMatrixCliConfig(),
    kind: "e2ee-setup",
    outputDir: requireMatrixQaE2eeOutputDir(params.context),
    runtimeEnv: () => requireMatrixQaCliRuntimeEnv(params.context),
  });
  return {
    configPath: runtime.configPath,
    dispose: runtime.dispose,
    run: (args: string[], timeoutMs = params.context.timeoutMs, stdin?: string) =>
      runtime.run(args, { stdin, timeoutMs }),
    rootDir: runtime.artifactDir,
    start: (args: string[], timeoutMs = params.context.timeoutMs) =>
      runtime.start(args, { timeoutMs }),
    stateDir: runtime.stateDir,
  };
}

export async function createMatrixQaCliGatewayRuntime(params: {
  artifactLabel: string;
  context: MatrixQaScenarioContext;
}) {
  const outputDir = requireMatrixQaE2eeOutputDir(params.context);
  const artifactDir = path.join(
    outputDir,
    params.artifactLabel,
    randomUUID().replaceAll("-", "").slice(0, 12),
  );
  await mkdir(artifactDir, { mode: 0o700, recursive: true });
  await chmod(artifactDir, 0o700).catch(() => undefined);
  await assertMatrixQaPrivatePathMode(artifactDir, "Matrix QA CLI artifact directory");
  const env = {
    ...requireMatrixQaCliRuntimeEnv(params.context),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    OPENCLAW_NO_AUTO_UPDATE: "1",
  };
  const run = async (args: string[], timeoutMs = params.context.timeoutMs) =>
    await runMatrixQaOpenClawCli({
      args,
      env,
      timeoutMs,
    });
  return {
    dispose: async () => undefined,
    rootDir: artifactDir,
    run,
  };
}
