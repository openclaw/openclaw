import { toErrorObject } from "../../infra/errors.js";
import { recordModelFallbackStop } from "../failover-error.js";
import { runOwnedAgentCleanup } from "../run-cleanup-timeout.js";
import { retainPublishedSandboxSkillsUntil } from "../sandbox/published-skills-handoff.js";
import { cliBackendLog } from "./log.js";
import type { RunCliAgentParams } from "./types.js";

/** Join CLI cleanup; replacement requires closure before any provider can proceed. */
export async function runCliCleanup(
  params: Pick<RunCliAgentParams, "runId" | "sessionId" | "oneShotCliRun"> & {
    skillsOwner?: object;
  },
  step: string,
  cleanup: () => Promise<void>,
  settlement?: "required",
): Promise<void> {
  const skillsOwner = params.skillsOwner;
  try {
    await runOwnedAgentCleanup({
      ...params,
      step,
      settlement,
      log: cliBackendLog,
      // A reporting timeout does not retire the underlying resource consumer.
      cleanup: skillsOwner
        ? () => retainPublishedSandboxSkillsUntil(skillsOwner, Promise.resolve().then(cleanup))
        : cleanup,
    });
  } catch (error) {
    if (settlement !== "required") {
      throw error;
    }
    const failure = toErrorObject(error, "CLI resource cleanup failed");
    // A different provider must not replace resources whose previous owner is still unclosed.
    recordModelFallbackStop(failure);
    throw failure;
  }
}
