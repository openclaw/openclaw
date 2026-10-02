import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import {
  captureRuntimeConfigWithSource,
  type CapturedRuntimeConfigRead,
} from "../../config/runtime-config-capture-state.js";
import { resolveStateDir } from "../../config/state-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { tryProcessCwd } from "../../infra/safe-cwd.js";

export type AcpSessionReadContextInput = {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  assertCurrent?: () => void;
};

/** Capture routing inputs before a read yields, retaining the caller's live assertion. */
export async function captureAcpSessionReadContext(params: AcpSessionReadContextInput) {
  const cwd = tryProcessCwd();
  const assertCallerCurrent = params.assertCurrent;
  const databasePath = params.databasePath ? path.resolve(params.databasePath) : undefined;
  const suppliedEnv = params.env ? cloneEnvWithPlatformSemantics(params.env) : undefined;
  const assertInputCurrent = () => {
    assertCallerCurrent?.();
    if (tryProcessCwd() !== cwd) {
      throw new Error("ACP session read working directory changed; retry the read.");
    }
  };
  assertInputCurrent();
  let assertCurrent = assertInputCurrent;
  let captured: CapturedRuntimeConfigRead;
  if (params.cfg) {
    captured = {
      config: captureRuntimeConfigWithSource(params.cfg, params.cfg),
      env: cloneEnvWithPlatformSemantics(process.env),
    };
  } else {
    const read = captureRuntimeConfigAsyncReader({
      capture: true,
      assertCurrent: assertInputCurrent,
    });
    captured = await read();
    assertCurrent = read.assertCurrent;
  }
  assertCurrent();
  const env = suppliedEnv ?? captured.env;
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  return { cfg: captured.config, env, databasePath, assertCurrent };
}
