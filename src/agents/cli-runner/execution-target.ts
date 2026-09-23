import { createAbortError } from "../../infra/abort-signal.js";
import type { CliBackendExecute } from "../../plugins/cli-backend.types.js";
import { getPluginValueInstance } from "../../plugins/plugin-instance-scope.js";
import type { PluginInstanceConsumer } from "../../plugins/plugin-instance.types.js";
import { resolveAdmittedRunActiveAssertion } from "../admitted-run-context.js";
import type { CliExecutionTarget, PreparedCliRunContext, RunCliAgentParams } from "./types.js";

/** Capture both the admitted run and any narrower caller-owned execution authority. */
export function createCliRunCurrentAssertion(
  params: PreparedCliRunContext["params"],
  signal = params.abortSignal,
): () => void {
  const assertCallerCurrent = params.assertCurrent;
  const assertAdmitted = resolveAdmittedRunActiveAssertion(params.admittedRunContext, signal);
  return () => {
    assertCallerCurrent?.();
    if (signal?.aborted) {
      throw createAbortError("CLI run aborted");
    }
    if (!assertAdmitted) {
      throw new Error("CLI run authority is no longer active");
    }
    assertAdmitted();
  };
}

/** Preparation and execution must agree on the owner of private prompt context. */
export function resolveCliExecutionTarget(context: {
  params: Pick<RunCliAgentParams, "sessionEntry" | "controlOperation">;
  backendId: string;
  execute?: CliBackendExecute;
}): CliExecutionTarget {
  const entry = context.params.sessionEntry;
  // Claude placement owns its CLI, auth, transcript, and exec tools together.
  if (context.backendId === "claude-cli" && entry?.execHost === "node") {
    const nodeId = entry.execNode?.trim();
    if (!nodeId) {
      throw new Error("node-placed Claude CLI session is missing execNode");
    }
    return {
      kind: "node",
      placement: { nodeId, ...(entry.execCwd?.trim() ? { cwd: entry.execCwd.trim() } : {}) },
    };
  }
  return context.execute && context.params.controlOperation !== "compact"
    ? { kind: "plugin", execute: context.execute }
    : { kind: "process" };
}

/**
 * A plugin hot reload retires the previous backend instance after a bounded call
 * drain and then rejects its calls, which discarded turns that finished later.
 * A retained consumer keeps every plugin call of one prepared turn (execution
 * stream, lifecycle parser, text transforms, cleanup) admitted on that instance
 * until the turn's cleanup releases it; the owner's physical cleanup waits for it.
 */
export function retainCliPluginExecutionConsumer(
  execute: CliBackendExecute | undefined,
): PluginInstanceConsumer | undefined {
  const owner = execute ? getPluginValueInstance(execute) : undefined;
  if (!owner) {
    return undefined;
  }
  try {
    return owner.retainConsumer();
  } catch {
    // The owner is already retiring; the ordinary call path reports that itself.
    return undefined;
  }
}
