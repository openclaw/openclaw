import { embeddedAgentLog, runAgentCleanupStep } from "openclaw/plugin-sdk/agent-harness-runtime";

/** One cached disposal operation; required callers retain failures, ordinary cleanup stays best-effort. */
export function createCodexAttemptToolDisposer(input: {
  runId: string;
  sessionId: string;
  oneShotCliRun?: boolean;
  runCleanups: Array<(reason: string) => Promise<void>>;
  disposeScopedMcp: () => Promise<void>;
  disposeConfiguredMcp: () => Promise<void>;
}) {
  let toolDisposal: Promise<void> | undefined;
  let toolDisposalRequired = false;
  const toolDisposalFailures: unknown[] = [];
  const disposeTools = async (reason: string, settlement?: "required"): Promise<void> => {
    if (!toolDisposal) {
      toolDisposalRequired = settlement === "required";
      toolDisposal = (async () => {
        const disposeStep = async (step: string, cleanup: () => Promise<void>) => {
          try {
            await runAgentCleanupStep({
              runId: input.runId,
              sessionId: input.sessionId,
              step,
              log: embeddedAgentLog,
              settlement: toolDisposalRequired ? "required" : undefined,
              cleanup,
            });
          } catch (error) {
            // Join every owned disposer before reporting failed required settlement.
            toolDisposalFailures.push(error);
          }
        };
        await disposeStep("codex-dynamic-tool-cleanup", async () => {
          const settled = await Promise.allSettled(
            input.runCleanups.splice(0).map(async (cleanup) => await cleanup(reason)),
          );
          const errors = settled.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if ((input.oneShotCliRun || toolDisposalRequired) && errors.length) {
            throw new AggregateError(errors, "Codex tool cleanup failed");
          }
        });
        for (const [step, cleanup] of [
          ["codex-scoped-mcp-dispose", input.disposeScopedMcp],
          ["codex-configured-mcp-dispose", input.disposeConfiguredMcp],
        ] as const) {
          await disposeStep(step, cleanup);
        }
      })();
    }
    await toolDisposal;
    if (settlement === "required") {
      // An earlier best-effort call cannot be upgraded into a closure certificate.
      if (!toolDisposalRequired) {
        throw new Error("Codex tool cleanup did not record required settlement");
      }
      if (toolDisposalFailures.length) {
        throw new AggregateError(toolDisposalFailures, "Required Codex tool cleanup failed");
      }
    }
  };
  return disposeTools;
}
