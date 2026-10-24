import { parseBooleanValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { QaSuiteScenarioResult } from "./suite-types.js";

/**
 * One bounded retry for live-model flake: flow scenarios time out under model
 * latency spikes, so a first failure gets a single rerun. A retry pass keeps
 * the first attempt visible in details; a retry failure keeps the original
 * diagnostics so deterministic regressions still fail the suite.
 */
export async function runQaScenarioWithFlakeRetry(
  run: () => Promise<QaSuiteScenarioResult>,
  onRetry?: () => void,
): Promise<QaSuiteScenarioResult> {
  const first = await run();
  if (first.status !== "fail") {
    return first;
  }
  onRetry?.();
  const second = await run();
  if (second.status !== "pass") {
    return first;
  }
  return {
    ...second,
    details: [second.details, `passed on retry; first attempt: ${first.details ?? "failed"}`]
      .filter(Boolean)
      .join(" | "),
  };
}

function appendNodeOption(raw: string | undefined, option: string) {
  const parts = (raw ?? "").split(/\s+/u).filter(Boolean);
  return parts.includes(option) ? parts.join(" ") : [...parts, option].join(" ");
}

export function shouldCaptureGatewayHeapCheckpoints(env: NodeJS.ProcessEnv = process.env) {
  return parseBooleanValue(env.OPENCLAW_QA_GATEWAY_HEAP_CHECKPOINTS) === true;
}

export function buildQaGatewayHeapCheckpointRuntimeEnvPatch(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv | undefined {
  if (!shouldCaptureGatewayHeapCheckpoints(env)) {
    return undefined;
  }
  return {
    NODE_OPTIONS: appendNodeOption(env.NODE_OPTIONS, "--heapsnapshot-signal=SIGQUIT"),
  };
}

export function mergeQaRuntimeEnvPatches(
  ...patches: Array<NodeJS.ProcessEnv | undefined>
): NodeJS.ProcessEnv | undefined {
  const merged: NodeJS.ProcessEnv = {};
  Object.assign(merged, ...patches);
  return Object.keys(merged).length > 0 ? merged : undefined;
}
