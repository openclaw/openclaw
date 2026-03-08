import { isTruthyEnvValue } from "../../infra/env.js";

export const EXECUTION_GRAPH_V0_ENABLE_ENV = "OPENCLAW_EXECUTION_GRAPH_V0";
export const EXECUTION_GRAPH_V0_KILL_SWITCH_ENV = "OPENCLAW_EXECUTION_GRAPH_V0_DISABLE";

export function isExecutionGraphRuntimeV0Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isTruthyEnvValue(env[EXECUTION_GRAPH_V0_KILL_SWITCH_ENV])) {
    return false;
  }
  return isTruthyEnvValue(env[EXECUTION_GRAPH_V0_ENABLE_ENV]);
}
